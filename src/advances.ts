// Anticipos de clientes (cuenta "Avances y anticipos recibidos", id 5031).
//
// Cómo funciona en la cuenta de MyOffice (verificado contra la API):
// - El anticipo es un pago recibido sin factura con una línea de categoría 5031 (behavior ADVANCE_IN):
//   acredita 5031 a nombre del cliente.
// - Al aplicarlo, Alegra lo guarda en la factura (`advances[]`, solo sale con fields=advances; trae el
//   id del pago en `transaction`) y genera un comprobante contable automático "Se ajusta a causa del
//   anticipo asociado a la factura número: X" que debita 5031 y acredita Cuentas por cobrar.
// - También puede haber asientos manuales sobre 5031 y devoluciones (pagos de egreso con 5031).
//
// El saldo por cliente es el contable: créditos de los pagos 5031 menos débitos netos de los
// comprobantes en 5031 (/journals/entries) menos devoluciones. El detalle por anticipo usa las
// aplicaciones de las facturas; lo que el comprobante contable debita sin una aplicación
// identificada (asientos manuales) se reparte por antigüedad (FIFO) y se informa como
// `aplicado_sin_detalle`.
//
// Las consultas de todos los clientes usan una caché local (advance-cache.ts) porque Alegra tarda
// varios minutos en entregar el historial completo; las de un cliente se consultan en vivo.
import * as alegra from './alegra.js';
import { money, sum, isZero, today, addDays, clientRef, checkRange } from './format.js';
import { getAdvanceCache, linesUpTo, type CachedLine } from './advance-cache.js';

const ADV = alegra.ADVANCE_CATEGORY_ID;
// Ventana por defecto de list_advances cuando no se filtra por cliente ni por fechas
const DEFAULT_WINDOW_DAYS = 90;

export type Client = ReturnType<typeof clientRef>;

export interface AdvancePayment {
    id: string;
    number: string | null;
    date: string;
    type: 'in' | 'out';
    amount: number;          // porción del pago en la cuenta 5031
    client: Client;
    paymentMethod: string | null;
    bankAccount: { id: string; name: string } | null;
    anotation: string | null;
    observations: string | null;
}

export interface Application {
    paymentId: string;
    amount: number;
    date: string;            // fecha en que se aplicó
    invoice: { id: string; number: string | null; date: string };
}

interface ClientLedger {
    client: Client;
    advances: AdvancePayment[];   // anticipos recibidos (pagos de ingreso)
    refunds: AdvancePayment[];    // devoluciones (pagos de egreso a 5031)
    received: number;
    journalNet: number;           // débitos - créditos de comprobantes contables en 5031
    refunded: number;
    applied: number;              // journalNet + refunded
    balance: number;              // received - applied
}

export function toAdvance(p: any): AdvancePayment {
    return {
        id: String(p.id),
        number: p.numberTemplate?.fullNumber ?? p.number ?? null,
        date: p.date,
        type: p.type,
        amount: sum((p.categories ?? []).filter((c: any) => String(c.id) === ADV).map((c: any) => Number(c.total))),
        client: clientRef(p.client),
        paymentMethod: p.paymentMethod ?? null,
        bankAccount: p.bankAccount ? { id: String(p.bankAccount.id), name: p.bankAccount.name } : null,
        anotation: p.anotation ?? null,
        observations: p.observations ?? null,
    };
}

// Pagos con línea en la cuenta 5031 (ingresos y egresos), sin anulados
export async function fetchAdvancePayments(params: Record<string, string | undefined>): Promise<AdvancePayment[]> {
    const { data } = await alegra.alegraList('/payments', { category_id: ADV, order_direction: 'ASC', ...params }, Infinity);
    return data.filter((p: any) => p.status !== 'void').map(toAdvance);
}

export function toLine(l: any, month: string | null): CachedLine {
    return {
        id: String(l.id),
        idJournal: String(l.idJournal),
        client: l.client ? clientRef(l.client) : null,
        debit: Number(l.debit ?? 0),
        credit: Number(l.credit ?? 0),
        month,
    };
}

// Aplicaciones de anticipos registradas en las facturas (de un cliente o de un rango de fechas)
export function invoiceApplications(i: any): Application[] {
    if (i.status === 'void' || i.status === 'draft') return [];
    return (i.advances ?? [])
        .filter((a: any) => String(a.category?.id ?? ADV) === ADV)
        .map((a: any) => ({
            paymentId: String(a.transaction),
            amount: money(a.amount),
            date: a.dateApplied ?? i.date,
            invoice: { id: String(i.id), number: i.numberTemplate?.number ?? null, date: i.date },
        }));
}

export async function loadApplications(clientId: string): Promise<Application[]> {
    const { data } = await alegra.alegraList('/invoices', { client_id: clientId, fields: 'advances' }, Infinity);
    return data.flatMap(invoiceApplications);
}

const clientKey = (c: Client) => c?.id ?? 'sin-cliente';

function buildLedger(payments: AdvancePayment[], lines: CachedLine[], asOf: string): Map<string, ClientLedger> {
    const ledger = new Map<string, ClientLedger>();
    const get = (client: Client) => {
        const key = clientKey(client);
        if (!ledger.has(key)) ledger.set(key, { client, advances: [], refunds: [], received: 0, journalNet: 0, refunded: 0, applied: 0, balance: 0 });
        const l = ledger.get(key)!;
        if (!l.client && client) l.client = client;
        return l;
    };
    for (const p of payments) {
        if (p.date > asOf) continue;
        const l = get(p.client);
        if (p.type === 'in') l.advances.push(p); else l.refunds.push(p);
    }
    for (const line of lines) get(line.client).journalNet += line.debit - line.credit;
    for (const l of ledger.values()) {
        l.advances.sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
        l.received = sum(l.advances.map(a => a.amount));
        l.refunded = sum(l.refunds.map(a => a.amount));
        l.journalNet = money(l.journalNet);
        l.applied = money(l.journalNet + l.refunded);
        l.balance = money(l.received - l.applied);
    }
    return ledger;
}

// Reparte lo aplicado entre los anticipos del cliente: primero las aplicaciones identificadas en
// facturas, después el resto por antigüedad
function allocate(l: ClientLedger, apps: Application[], asOf: string) {
    const own = new Set(l.advances.map(a => a.id));
    const valid = apps.filter(a => a.date <= asOf && own.has(a.paymentId));
    const byPayment = new Map<string, Application[]>();
    for (const a of valid) byPayment.set(a.paymentId, [...(byPayment.get(a.paymentId) ?? []), a]);
    let residual = money(l.applied - sum(valid.map(a => a.amount)));
    const rows = l.advances.map(adv => {
        const applications = byPayment.get(adv.id) ?? [];
        return { adv, applications, onInvoices: sum(applications.map(a => a.amount)), other: 0 };
    });
    for (const r of rows) {
        if (residual <= 0) break;
        const take = money(Math.min(Math.max(0, r.adv.amount - r.onInvoices), residual));
        r.other = take;
        residual = money(residual - take);
    }
    return {
        rows: rows.map(r => {
            const applied = money(r.onInvoices + r.other);
            const pending = money(r.adv.amount - applied);
            return {
                ...r.adv,
                total_aplicado: applied,
                aplicado_en_facturas: r.onInvoices,
                aplicado_sin_detalle: r.other,
                saldo_por_facturar: pending,
                estado: isZero(pending) ? 'aplicado' : isZero(applied) ? 'pendiente' : pending < 0 ? 'sobreaplicado' : 'parcial',
                aplicaciones: r.applications.map(a => ({ invoice: a.invoice, amount: a.amount, date: a.date })),
            };
        }),
        // > 0: se aplicó más de lo recibido; < 0: aplicaciones en facturas sin comprobante contable
        unallocated: residual,
    };
}

function balanceNotes(results: { l: ClientLedger; unallocated: number }[]) {
    const notes: string[] = [];
    for (const r of results) {
        const name = r.l.client?.name ?? 'Pagos sin cliente';
        if (r.unallocated > 0.005) notes.push(`${name}: se aplicaron $${r.unallocated.toFixed(2)} más de lo recibido en anticipos (saldo negativo).`);
        if (r.unallocated < -0.005) notes.push(`${name}: hay $${(-r.unallocated).toFixed(2)} aplicados en facturas sin comprobante contable a la fecha.`);
    }
    return notes;
}

// Detalle por anticipo: de un cliente (en vivo, todo su historial) o de todos (desde la caché)
export async function listAdvances(opts: { clientId?: string; startDate?: string; endDate?: string; onlyPending?: boolean; refresh?: boolean }) {
    const asOf = today();
    const notes: string[] = [];
    let start = opts.startDate;
    const end = opts.endDate ?? asOf;
    if (!opts.clientId && !start) {
        start = addDays(end, -DEFAULT_WINDOW_DAYS);
        notes.push(`Sin cliente ni start_date: se listan los anticipos de los últimos ${DEFAULT_WINDOW_DAYS} días (${start} a ${end}). Para el saldo de todos los periodos use advance_balances_by_client.`);
    }
    if (start) checkRange(start, end, opts.clientId ? 36600 : 366);

    let client: any;
    let payments: AdvancePayment[];
    let lines: CachedLine[];
    let appsByClient: (key: string) => Application[];
    let syncedAt = new Date().toISOString();
    if (opts.clientId) {
        client = await alegra.getContact(opts.clientId);
        const [p, l, apps] = await Promise.all([
            fetchAdvancePayments({ client_id: opts.clientId }),
            alegra.listJournalLines({ category_id: ADV, client_id: opts.clientId }),
            loadApplications(opts.clientId),
        ]);
        payments = p;
        lines = l.filter(x => x.status !== 'void').map(x => toLine(x, null));
        appsByClient = () => apps;
    } else {
        const cache = await getAdvanceCache({ refresh: opts.refresh });
        payments = cache.payments;
        lines = cache.lines;
        appsByClient = key => cache.appsByClient(key);
        syncedAt = cache.syncedAt;
    }

    const ledger = buildLedger(payments, lines, asOf);
    const inWindow = (a: AdvancePayment) => (!start || a.date >= start) && a.date <= end;
    const results = [...ledger.entries()]
        .filter(([, l]) => l.advances.some(inWindow) || l.refunds.some(inWindow))
        .map(([key, l]) => ({ l, ...allocate(l, appsByClient(key), asOf) }));

    const advances = results.flatMap(r => r.rows)
        .filter(a => inWindow(a) && (!opts.onlyPending || !isZero(a.saldo_por_facturar)))
        .sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
    return {
        as_of: asOf,
        datos_al: syncedAt,
        filtros: { client_id: opts.clientId ?? null, start_date: start ?? null, end_date: end, only_pending: !!opts.onlyPending },
        ...(client && { client: clientRef(client) }),
        resumen: {
            cantidad: advances.length,
            total_anticipos: sum(advances.map(a => a.amount)),
            total_aplicado: sum(advances.map(a => a.total_aplicado)),
            saldo_por_facturar: sum(advances.map(a => a.saldo_por_facturar)),
            ...(opts.clientId && { saldo_anticipos_cliente: ledger.get(opts.clientId)?.balance ?? 0 }),
        },
        anticipos: advances,
        devoluciones: results.flatMap(r => r.l.refunds).filter(inWindow),
        notas: [...notes, ...balanceNotes(results)],
    };
}

// Saldo de anticipos por cliente a una fecha
export async function advanceBalancesByClient(opts: { asOf?: string; refresh?: boolean }) {
    const asOf = opts.asOf ?? today();
    if (asOf > today()) throw new Error(`as_of_date (${asOf}) no puede ser posterior a hoy`);
    const cache = await getAdvanceCache({ refresh: opts.refresh });
    const lines = await linesUpTo(cache, asOf);
    const ledger = buildLedger(cache.payments, lines, asOf);

    const withBalance = [...ledger.entries()].filter(([, l]) => !isZero(l.balance));
    const allocated = withBalance.map(([key, l]) => ({ key, l, ...allocate(l, cache.appsByClient(key), asOf) }));
    const rows = allocated.map(({ l, rows: advs }) => {
        const pending = advs.filter(r => r.saldo_por_facturar > 0.005);
        return {
            client_id: l.client?.id ?? null,
            client_name: l.client?.name ?? '(pago sin cliente)',
            identification: l.client?.identification ?? null,
            total_anticipos: l.received,
            total_aplicado: l.applied,
            saldo_por_facturar: l.balance,
            fecha_anticipo_pendiente_mas_antiguo: pending[0]?.date ?? null,
            anticipos_pendientes: pending.length,
        };
    });
    rows.sort((a, b) => b.saldo_por_facturar - a.saldo_por_facturar);

    const all = [...ledger.values()];
    const credits = sum(all.map(l => l.received));
    const journals = sum(all.map(l => l.journalNet));
    const refunds = sum(all.map(l => l.refunded));
    return {
        as_of: asOf,
        datos_al: cache.syncedAt,
        resumen: {
            clientes: rows.length,
            saldo_por_facturar: sum(rows.map(r => r.saldo_por_facturar)),
            clientes_con_saldo_negativo: rows.filter(r => r.saldo_por_facturar < 0).length,
        },
        conciliacion: {
            cuenta: `${ADV} - Avances y anticipos recibidos`,
            anticipos_recibidos: credits,
            debitos_comprobantes_contables: journals,
            devoluciones: refunds,
            saldo_cuenta: money(credits - journals - refunds),
            suma_por_cliente: sum(rows.map(r => r.saldo_por_facturar)),
            nota: 'El saldo se calcula con los mismos movimientos que registra Alegra en la cuenta: pagos con categoría 5031 ' +
                '(créditos), comprobantes contables sobre 5031 (aplicaciones a facturas y asientos manuales) y pagos de egreso a 5031. ' +
                'La API pública no expone el "Balance de prueba por tercero" (responde 403), así que compare "saldo_cuenta" con ' +
                'Reportes > Balance de prueba por tercero, cuenta "Avances y anticipos recibidos", al mismo corte.',
        },
        clientes: rows,
        notas: balanceNotes(allocated),
    };
}

// Saldo de anticipos de un cliente, en vivo (para get_contact)
export async function clientAdvanceBalance(clientId: string) {
    const [payments, lines] = await Promise.all([
        fetchAdvancePayments({ client_id: clientId }),
        alegra.listJournalLines({ category_id: ADV, client_id: clientId }),
    ]);
    const asOf = today();
    return buildLedger(payments, lines.filter(x => x.status !== 'void').map(x => toLine(x, null)), asOf).get(clientId)?.balance ?? 0;
}
