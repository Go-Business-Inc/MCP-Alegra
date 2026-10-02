// Caché local del historial de la cuenta de anticipos (5031).
//
// Alegra tarda 4-6 minutos en entregar todos los pagos de anticipos, las líneas contables de la
// cuenta y las facturas con anticipos aplicados, más de lo que Claude espera por una herramienta.
// Por eso se guarda una copia en data/cache/advances.json:
// - descarga completa la primera vez y luego una vez por semana, en segundo plano;
// - actualización incremental (últimos días) cuando la copia tiene más de 10 minutos;
// - al arrancar el servidor se pone al día en segundo plano.
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as alegra from './alegra.js';
import { fetchAdvancePayments, toLine, invoiceApplications, type AdvancePayment, type Application, type Client } from './advances.js';
import { today, addDays } from './format.js';

const CACHE_FILE = fileURLToPath(new URL('../data/cache/advances.json', import.meta.url));
const VERSION = 1;
const FRESH_MS = 10 * 60 * 1000;
const FULL_EVERY_MS = 7 * 24 * 60 * 60 * 1000;
// La actualización incremental vuelve a bajar los últimos días (por pagos editados o anulados) y las
// facturas recientes (un anticipo se puede aplicar días después de emitida la factura)
const OVERLAP_DAYS = 7;
const INVOICE_OVERLAP_DAYS = 45;

export interface CachedLine {
    id: string;
    idJournal: string;
    client: Client;
    debit: number;
    credit: number;
    month: string | null;   // YYYY-MM del comprobante (la API no trae la fecha de la línea)
}

interface CacheData {
    version: number;
    fullSyncAt: string;
    syncedAt: string;
    payments: AdvancePayment[];
    lines: CachedLine[];
    // Facturas con anticipos aplicados, por id
    invoices: Record<string, { clientId: string | null; date: string; apps: Application[] }>;
}

export interface AdvanceCache extends CacheData {
    appsByClient(clientId: string): Application[];
}

let current: CacheData | null = null;
let loading: Promise<void> | null = null;
let running: Promise<CacheData> | null = null;
let runningKind: 'full' | 'incremental' | null = null;
let progress = '';
let lastError: string | null = null;

const log = (msg: string) => process.stderr.write(`[advance-cache] ${msg}\n`);
const month = (date: string) => date.slice(0, 7);
const age = (iso: string) => Date.now() - new Date(iso).getTime();

function monthEnd(m: string) {
    const [y, mo] = m.split('-').map(Number);
    return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10);
}

function monthsBetween(from: string, to: string) {
    const out: string[] = [];
    for (let m = from; m <= to; m = month(addDays(monthEnd(m), 1))) out.push(m);
    return out;
}

function loadFromDisk() {
    loading ??= readFile(CACHE_FILE, 'utf8')
        .then(text => {
            const data = JSON.parse(text);
            if (data.version === VERSION && !current) current = data;
        })
        .catch(() => { /* sin caché todavía */ });
    return loading;
}

async function save(data: CacheData) {
    await mkdir(fileURLToPath(new URL('../data/cache/', import.meta.url)), { recursive: true });
    const tmp = CACHE_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, CACHE_FILE);
}

async function fetchLines(months: string[]): Promise<CachedLine[]> {
    const perMonth = await Promise.all(months.map(async m => {
        const lines = await alegra.listJournalLines({ category_id: alegra.ADVANCE_CATEGORY_ID, fromDate: `${m}-01`, toDate: monthEnd(m) });
        return lines.filter(l => l.status !== 'void').map(l => toLine(l, m));
    }));
    return perMonth.flat();
}

async function fetchInvoices(since: string) {
    const { data } = await alegra.alegraList('/invoices', { fields: 'advances', date_afterOrNow: since }, Infinity);
    return data.map((i: any) => ({ id: String(i.id), clientId: i.client?.id ? String(i.client.id) : null, date: i.date, apps: invoiceApplications(i) }));
}

async function fullSync(): Promise<CacheData> {
    const startedAt = new Date().toISOString();
    progress = 'descargando pagos de anticipos';
    const payments = await fetchAdvancePayments({});
    const first = payments.reduce((min, p) => (p.date < min ? p.date : min), today());
    progress = 'descargando comprobantes contables y facturas con anticipos';
    const [lines, invoices] = await Promise.all([
        fetchLines(monthsBetween(month(first), month(today()))),
        fetchInvoices(first),
    ]);
    const withApps = Object.fromEntries(invoices.filter(i => i.apps.length).map(({ id, ...rest }) => [id, rest]));
    return { version: VERSION, fullSyncAt: startedAt, syncedAt: startedAt, payments, lines, invoices: withApps };
}

async function incrementalSync(prev: CacheData): Promise<CacheData> {
    const startedAt = new Date().toISOString();
    const since = addDays(prev.syncedAt.slice(0, 10), -OVERLAP_DAYS);
    const sinceMonth = month(since);
    progress = 'actualizando movimientos recientes';
    const [payments, lines, invoices] = await Promise.all([
        fetchAdvancePayments({ date_afterOrNow: since }),
        fetchLines(monthsBetween(sinceMonth, month(today()))),
        fetchInvoices(addDays(since, -INVOICE_OVERLAP_DAYS)),
    ]);
    const merged = { ...prev.invoices };
    for (const { id, ...rest } of invoices) {
        if (rest.apps.length) merged[id] = rest; else delete merged[id];
    }
    return {
        ...prev,
        syncedAt: startedAt,
        payments: [...prev.payments.filter(p => p.date < since), ...payments],
        lines: [...prev.lines.filter(l => l.month && l.month < sinceMonth), ...lines],
        invoices: merged,
    };
}

function startSync(kind: 'full' | 'incremental'): Promise<CacheData> {
    if (running) return running;
    runningKind = kind;
    const t0 = Date.now();
    running = (kind === 'full' || !current ? fullSync() : incrementalSync(current))
        .then(async data => {
            current = data;
            lastError = null;
            await save(data).catch(e => log(`no se pudo guardar la caché: ${e.message}`));
            log(`sincronización ${kind} lista en ${Math.round((Date.now() - t0) / 1000)} s`);
            return data;
        })
        .catch(e => {
            lastError = alegra.scrubSecrets(e?.message ?? String(e));
            log(`falló la sincronización ${kind}: ${lastError}`);
            throw e;
        })
        .finally(() => { running = null; runningKind = null; });
    return running;
}

function withIndex(data: CacheData): AdvanceCache {
    let index: Map<string, Application[]> | undefined;
    return {
        ...data,
        appsByClient(clientId: string) {
            if (!index) {
                index = new Map();
                for (const inv of Object.values(data.invoices)) {
                    if (!inv.clientId) continue;
                    index.set(inv.clientId, [...(index.get(inv.clientId) ?? []), ...inv.apps]);
                }
            }
            return index.get(clientId) ?? [];
        },
    };
}

// Datos de anticipos de todos los clientes, al día (máximo 10 minutos de antigüedad)
export async function getAdvanceCache(opts: { refresh?: boolean } = {}): Promise<AdvanceCache> {
    await loadFromDisk();
    if (!current) {
        startSync('full').catch(() => { /* el error queda en lastError */ });
        throw new Error(
            'Preparando por primera vez el historial de anticipos (descarga completa desde Alegra, unos 5 minutos; ' +
            `ahora: ${progress || 'iniciando'}${lastError ? `; último error: ${lastError}` : ''}). ` +
            'Vuelva a intentar en unos minutos. Las consultas de un solo cliente (client_id) funcionan de inmediato.',
        );
    }
    if (age(current.fullSyncAt) > FULL_EVERY_MS && !running) {
        startSync('full').catch(() => { /* se reintenta en la próxima consulta */ });
    }
    // Mientras corre la descarga completa semanal se usan los datos guardados
    if (runningKind === 'full') return withIndex(current);
    if (opts.refresh || age(current.syncedAt) > FRESH_MS) await startSync('incremental');
    return withIndex(current!);
}

// Líneas contables hasta una fecha de corte. Las líneas no traen fecha, solo el mes en que se
// descargaron; si el corte cae a mitad de mes, ese mes se consulta en vivo.
export async function linesUpTo(cache: AdvanceCache, asOf: string): Promise<CachedLine[]> {
    if (asOf >= today()) return cache.lines;
    const m = month(asOf);
    const before = cache.lines.filter(l => l.month && l.month < m);
    if (asOf === monthEnd(m)) return [...before, ...cache.lines.filter(l => l.month === m)];
    const partial = await alegra.listJournalLines({ category_id: alegra.ADVANCE_CATEGORY_ID, fromDate: `${m}-01`, toDate: asOf });
    return [...before, ...partial.filter(l => l.status !== 'void').map(l => toLine(l, m))];
}

// Al arrancar el servidor: carga la caché y la pone al día en segundo plano
export async function warmAdvanceCache() {
    await loadFromDisk();
    const kind = !current || age(current.fullSyncAt) > FULL_EVERY_MS ? 'full' : 'incremental';
    startSync(kind).catch(() => { /* el error queda en lastError */ });
}

// Descarga completa en primer plano (npm run sync-advances)
export async function fullSyncNow() {
    await loadFromDisk();
    const data = await startSync('full');
    return { payments: data.payments.length, lines: data.lines.length, invoicesWithAdvances: Object.keys(data.invoices).length };
}
