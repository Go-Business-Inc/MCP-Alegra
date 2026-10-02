import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// El .env vive en la raíz del repo; se resuelve relativo a este archivo porque Claude
// lanza el MCP desde cualquier carpeta.
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const BASE_URL = 'https://api.alegra.com/api/v1';
// Alegra devuelve máximo 30 registros por página
const PAGE_LIMIT = 30;
// Tope de registros por consulta; si hay más, la respuesta avisa que quedó truncada
export const MAX_RECORDS = Number(process.env.ALEGRA_MAX_RECORDS ?? 2000);
// Solicitudes simultáneas a Alegra: con más de 3 empieza a responder 503
const MAX_CONCURRENT = 3;
const MAX_RETRIES = 6;

function authHeader(): string {
    const user = process.env.ALEGRA_USER;
    const token = process.env.ALEGRA_TOKEN;
    if (!user || !token) {
        throw new Error('Faltan ALEGRA_USER / ALEGRA_TOKEN en el entorno (.env)');
    }
    return 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
}

// Quita el token (en claro o en Basic) de cualquier texto que vaya a salir en una respuesta
export function scrubSecrets(text: string): string {
    const token = process.env.ALEGRA_TOKEN;
    const user = process.env.ALEGRA_USER;
    if (!token) return text;
    let out = text.split(token).join('***');
    if (user) out = out.split(Buffer.from(`${user}:${token}`).toString('base64')).join('***');
    return out;
}

export class AlegraError extends Error {
    constructor(public status: number, public body: unknown) {
        super(scrubSecrets(`Alegra HTTP ${status}: ${typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body)}`));
    }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Semáforo global para no saturar la API
let active = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= MAX_CONCURRENT) await new Promise<void>(r => waiting.push(r));
    active++;
    try {
        return await fn();
    } finally {
        active--;
        waiting.shift()?.();
    }
}

// 429 = demasiadas solicitudes; 5xx = Alegra caído o saturado (pasa seguido con consultas pesadas)
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function request<T>(method: 'GET' | 'POST', url: URL | string, payload?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
        const res = await withSlot(() => fetch(url, {
            method,
            headers: {
                Authorization: authHeader(),
                Accept: 'application/json',
                ...(payload !== undefined && { 'Content-Type': 'application/json' }),
            },
            body: payload !== undefined ? JSON.stringify(payload) : undefined,
        }));
        const text = await res.text();
        let body: any = text;
        try { body = JSON.parse(text); } catch { /* respuesta no JSON */ }
        if (res.ok) return body as T;
        // Un POST solo se reintenta con 429: con un 5xx el pago pudo haberse creado
        const retryable = method === 'GET' ? RETRYABLE.has(res.status) : res.status === 429;
        if (!retryable || attempt >= MAX_RETRIES) throw new AlegraError(res.status, body);
        const retryAfter = Number(res.headers.get('retry-after'));
        await sleep(retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt);
    }
}

export async function alegraGet<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    return request<T>('GET', url);
}

export const alegraPost = <T = any>(path: string, payload: unknown) => request<T>('POST', BASE_URL + path, payload);

export interface ListResult<T> {
    data: T[];
    total: number;       // registros que reporta Alegra
    truncated: boolean;  // true si se cortó en el tope
}

// Recorre todas las páginas de un listado (start/limit de a 30) en paralelo, hasta `max` registros.
// Alegra repite un pago por cada línea de categoría que coincide con el filtro, por eso se
// eliminan repetidos por id.
export async function alegraList<T extends { id: string | number } = any>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    max = MAX_RECORDS,
): Promise<ListResult<T>> {
    const first = await alegraGet<{ data: T[]; metadata: { total: number } }>(path, { ...params, start: 0, limit: PAGE_LIMIT, metadata: 'true' });
    const total = Number(first.metadata?.total ?? first.data.length);
    const end = Math.min(total, max);
    const starts: number[] = [];
    for (let s = PAGE_LIMIT; s < end; s += PAGE_LIMIT) starts.push(s);
    const pages = await Promise.all(starts.map(start => alegraGet<T[]>(path, { ...params, start, limit: PAGE_LIMIT })));
    const seen = new Set<string>();
    const data: T[] = [];
    for (const row of [first.data, ...pages].flat()) {
        if (seen.has(String(row.id))) continue;
        seen.add(String(row.id));
        data.push(row);
    }
    const truncated = total > end;
    return { data: truncated ? data.slice(0, max) : data, total, truncated };
}

// Listado completo sin tope (lo usan las herramientas de un solo día)
export async function alegraGetAll<T extends { id: string | number } = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T[]> {
    return (await alegraList<T>(path, params, Infinity)).data;
}

// Líneas de comprobantes contables (/journals/entries). Endpoint distinto: pagina con page/limit,
// acepta hasta 500 por página y filtra por cuenta (category_id), tercero (client_id) y fechas
// (fromDate/toDate, ambas obligatorias juntas).
export async function listJournalLines(params: Record<string, string | number | undefined>): Promise<any[]> {
    const LIMIT = 500;
    const first = await alegraGet<{ data: any[]; metadata: { total: number } }>('/journals/entries', { ...params, limit: LIMIT, page: 1 });
    const pagesCount = Math.ceil(Number(first.metadata?.total ?? 0) / LIMIT);
    const rest = await Promise.all(
        Array.from({ length: Math.max(0, pagesCount - 1) }, (_, i) =>
            alegraGet<{ data: any[] }>('/journals/entries', { ...params, limit: LIMIT, page: i + 2 }).then(r => r.data)),
    );
    return [first.data, ...rest].flat();
}

// Listado por rango de fechas y, opcionalmente, por cliente. En /payments Alegra ignora los filtros de
// fecha cuando se envía client_id, así que se pide la variante con menos registros (todo el cliente o
// todo el rango) y el resto se filtra aquí.
export async function alegraListRange<T extends { id: string | number; date: string; client?: any } = any>(
    path: string,
    opts: { start: string; end: string; clientId?: string; params?: Record<string, string | number | undefined> },
): Promise<ListResult<T>> {
    const params = { ...opts.params, order_direction: 'ASC' };
    const byDate = { ...params, date_afterOrNow: opts.start, date_beforeOrNow: opts.end };
    if (!opts.clientId) return alegraList<T>(path, byDate);
    const byClient = { ...params, client_id: opts.clientId };
    const count = async (p: Record<string, any>) =>
        Number((await alegraGet<{ metadata: { total: number } }>(path, { ...p, limit: 1, metadata: 'true' })).metadata?.total ?? 0);
    const [nClient, nDate] = await Promise.all([count(byClient), count(byDate)]);
    const res = await alegraList<T>(path, nClient <= nDate ? byClient : byDate, Infinity);
    const data = res.data.filter(r => r.date >= opts.start && r.date <= opts.end && String(r.client?.id) === String(opts.clientId));
    const truncated = data.length > MAX_RECORDS;
    return { data: truncated ? data.slice(0, MAX_RECORDS) : data, total: data.length, truncated };
}

// Prefijos de las numeraciones de factura, para mostrar el número corto (#13339) a partir del
// completo (00113339) que traen los pagos
let prefixes: Promise<string[]> | undefined;
export function invoicePrefixes(): Promise<string[]> {
    prefixes ??= alegraGet<any[]>('/number-templates')
        .then(ts => [...new Set(ts.map(t => String(t.prefix ?? '')).filter(Boolean))].sort((a, b) => b.length - a.length))
        .catch(() => { prefixes = undefined; return []; });
    return prefixes;
}

// Cuentas y categorías de MyOffice (sobrescribibles por .env)
export const BAC_ACCOUNT_ID = process.env.ALEGRA_BAC_ACCOUNT_ID ?? '10';        // BAC Internat. Bank
export const ADVANCE_CATEGORY_ID = process.env.ALEGRA_ADVANCE_CATEGORY_ID ?? '5031'; // Avances y anticipos recibidos
export const RECEIVABLE_CATEGORY_ID = process.env.ALEGRA_RECEIVABLE_CATEGORY_ID ?? '5007'; // Cuentas por cobrar clientes

// Facturas abiertas con saldo. Alegra deja en estado "open" algunas facturas con saldo 0, por eso se
// filtra por saldo además del estado.
export async function listOpenInvoices(opts: { since?: string; clientId?: string; minBalance?: number } = {}): Promise<any[]> {
    const { data } = await alegraList('/invoices', {
        status: 'open',
        client_id: opts.clientId,
        date_afterOrNow: opts.since,
        order_direction: 'DESC',
    }, Infinity);
    const min = opts.minBalance ?? 0.005;
    return data.filter((i: any) => Number(i.balance ?? 0) >= min);
}

// Cliente por id, con error claro si no existe
export async function getContact(id: string | number): Promise<any> {
    try {
        return await alegraGet(`/contacts/${id}`);
    } catch (e) {
        if (e instanceof AlegraError && (e.status === 404 || e.status === 400)) throw new Error(`Cliente no encontrado (id ${id})`);
        throw e;
    }
}

export const getCompany = () => alegraGet('/company');
export const getPayment = (id: string | number) => alegraGet(`/payments/${id}`);
export const searchContacts = (query: string) => alegraGet<any[]>('/contacts', { query, start: 0, limit: 30 });
export const createPayment = (payload: unknown) => alegraPost('/payments', payload);
export const getInvoice = (id: string | number) => alegraGet(`/invoices/${id}`);
// El filtro `date` de Alegra es lento (y a veces responde 503); el de rango con la misma fecha no
const sameDay = (date: string) => ({ date_afterOrNow: date, date_beforeOrNow: date, order_direction: 'ASC' });
export const listInvoicesByDate = (date: string) => alegraGetAll('/invoices', sameDay(date));
export const listPaymentsByDate = (date: string) => alegraGetAll('/payments', sameDay(date));
export const listCreditNotesByDate = (date: string) => alegraGetAll('/credit-notes', sameDay(date));
export const listNumberTemplates = () => alegraGet('/number-templates');
export const listBankAccounts = () => alegraGet('/bank-accounts');
export const listSellers = () => alegraGet('/sellers');
