// Formato común de las respuestas: mismos nombres de campo en todas las herramientas,
// fechas YYYY-MM-DD y montos redondeados a 2 decimales.

export const money = (n: unknown) => Math.round((Number(n) || 0) * 100) / 100;
export const sum = (xs: number[]) => money(xs.reduce((s, x) => s + x, 0));
// Montos que se consideran cero (residuos de redondeo de la API)
export const isZero = (n: number) => Math.abs(n) < 0.005;

export const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Panama' });

export function addDays(date: string, days: number) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Valida un rango de fechas. Las consultas de rango se limitan a un año para no saturar Alegra.
export function checkRange(start: string, end: string, maxDays = 366) {
    if (start > end) throw new Error(`Rango inválido: start_date (${start}) es posterior a end_date (${end})`);
    if (addDays(start, maxDays) < end) throw new Error(`Rango de fechas mayor a 1 año (${start} a ${end}); divida la consulta en periodos más cortos`);
}

export const clientRef = (c: any) => c ? { id: String(c.id), name: String(c.name ?? '').trim(), identification: c.identification ?? null } : null;
const named = (x: any) => x ? { id: String(x.id), name: x.name } : null;
const docNumber = (d: any) => d?.numberTemplate?.number ?? d?.number ?? null;
const fullNumber = (d: any) => d?.numberTemplate?.fullNumber ?? null;

// Número corto de una factura referenciada en un pago o nota de crédito ("00113339" -> "13339")
let knownPrefixes: string[] = [];
export const setInvoicePrefixes = (p: string[]) => { knownPrefixes = p; };
export function shortNumber(full: string | null | undefined, prefix?: string | null) {
    if (!full) return null;
    const pre = prefix ?? knownPrefixes.find(p => full.startsWith(p) && full.length > p.length);
    return pre && full.startsWith(pre) ? full.slice(pre.length) : full;
}
const invoiceRef = (i: any) => ({ id: String(i.id), number: shortNumber(i.fullNumber ?? i.number, i.prefix), fullNumber: i.fullNumber ?? i.number ?? null });

export function fmtPayment(p: any) {
    return {
        id: String(p.id),
        number: p.numberTemplate?.fullNumber ?? p.number ?? null,
        date: p.date,
        type: p.type,
        amount: money(p.amount),
        status: p.status,
        paymentMethod: p.paymentMethod ?? null,
        bankAccount: p.bankAccount ? { id: String(p.bankAccount.id), name: p.bankAccount.name } : null,
        client: clientRef(p.client),
        anotation: p.anotation ?? null,
        observations: p.observations ?? null,
        invoices: (p.invoices ?? []).map((i: any) => ({ ...invoiceRef(i), amount: money(i.amount) })),
        categories: (p.categories ?? []).map((c: any) => ({ id: String(c.id), name: c.name, total: money(c.total), behavior: c.behavior || null })),
    };
}

export function fmtInvoice(i: any, opts: { items?: boolean } = {}) {
    return {
        id: String(i.id),
        number: docNumber(i),
        fullNumber: fullNumber(i),
        date: i.date,
        dueDate: i.dueDate ?? null,
        status: i.status,
        client: clientRef(i.client),
        subtotal: money(i.subtotal),
        discount: money(i.discount),
        tax: money(i.tax),
        total: money(i.total),
        totalPaid: money(i.totalPaid),
        balance: money(i.balance),
        seller: named(i.seller),
        costCenter: named(i.costCenter),
        term: i.term ?? null,
        originApp: i.originApp ?? 'WEB',
        anotation: i.anotation ?? null,
        ...(opts.items && {
            items: (i.items ?? []).map((it: any) => ({
                id: String(it.id),
                name: it.name,
                description: it.description ?? null,
                reference: it.reference ?? null,
                quantity: Number(it.quantity),
                price: money(it.price),
                discount: Number(it.discount ?? 0),
                tax: sum((it.tax ?? []).map((t: any) => Number(t.amount ?? 0))),
                total: money(it.total),
            })),
        }),
    };
}

export function fmtCreditNote(c: any) {
    return {
        id: String(c.id),
        number: docNumber(c),
        fullNumber: fullNumber(c),
        date: c.date,
        status: c.status,
        client: clientRef(c.client),
        subtotal: money(c.subtotal),
        tax: money(c.tax),
        total: money(c.total),
        totalApplied: money(c.totalApplied),
        balance: money(c.balance),
        anotation: c.anotation ?? null,
        invoices: (c.invoices ?? []).map((i: any) => ({ ...invoiceRef(i), date: i.date, amount: money(i.amount) })),
    };
}

// Aviso estándar cuando un listado llegó al tope de registros
export const truncationNote = (shown: number, total: number) =>
    `Resultado truncado: se devuelven ${shown} de ${total} registros. Acote el rango de fechas o filtre por cliente.`;
