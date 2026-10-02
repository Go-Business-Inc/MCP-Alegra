// Consultas de solo lectura: pagos, facturas, notas de crédito y clientes.
import * as alegra from './alegra.js';
import { clientAdvanceBalance } from './advances.js';
import { fmtPayment, fmtInvoice, fmtCreditNote, sum, checkRange, truncationNote, clientRef, setInvoicePrefixes } from './format.js';

const loadPrefixes = async () => setInvoicePrefixes(await alegra.invoicePrefixes());

// Valida el cliente antes de consultar, para devolver "cliente no encontrado" en lugar de una lista vacía
const ensureClient = async (clientId?: string) => { if (clientId) await alegra.getContact(clientId); };

const withTruncation = (res: { data: unknown[]; total: number; truncated: boolean }) =>
    res.truncated ? { truncated: true, aviso: truncationNote(res.data.length, res.total) } : { truncated: false };

export async function listPaymentsRange(opts: { startDate: string; endDate: string; clientId?: string; type?: 'in' | 'out' }) {
    checkRange(opts.startDate, opts.endDate);
    await ensureClient(opts.clientId);
    const [res] = await Promise.all([
        alegra.alegraListRange('/payments', { start: opts.startDate, end: opts.endDate, clientId: opts.clientId, params: { type: opts.type } }),
        loadPrefixes(),
    ]);
    const payments = res.data.map(fmtPayment);
    const active = payments.filter(p => p.status !== 'void');
    return {
        filtros: { start_date: opts.startDate, end_date: opts.endDate, client_id: opts.clientId ?? null, type: opts.type ?? null },
        resumen: {
            cantidad: payments.length,
            anulados: payments.length - active.length,
            total_ingresos: sum(active.filter(p => p.type === 'in').map(p => p.amount)),
            total_egresos: sum(active.filter(p => p.type === 'out').map(p => p.amount)),
        },
        ...withTruncation(res),
        payments,
    };
}

export async function listCreditNotesRange(opts: { startDate: string; endDate: string; clientId?: string }) {
    checkRange(opts.startDate, opts.endDate);
    await ensureClient(opts.clientId);
    const [res] = await Promise.all([
        alegra.alegraListRange('/credit-notes', { start: opts.startDate, end: opts.endDate, clientId: opts.clientId }),
        loadPrefixes(),
    ]);
    const notes = res.data.map(fmtCreditNote);
    const active = notes.filter(n => n.status !== 'void');
    return {
        filtros: { start_date: opts.startDate, end_date: opts.endDate, client_id: opts.clientId ?? null },
        resumen: { cantidad: notes.length, anuladas: notes.length - active.length, total: sum(active.map(n => n.total)), total_aplicado: sum(active.map(n => n.totalApplied)) },
        ...withTruncation(res),
        creditNotes: notes,
    };
}

export async function listInvoicesRange(opts: { startDate: string; endDate: string; clientId?: string; status?: string; items?: boolean }) {
    checkRange(opts.startDate, opts.endDate);
    await ensureClient(opts.clientId);
    const res = await alegra.alegraListRange('/invoices', { start: opts.startDate, end: opts.endDate, clientId: opts.clientId, params: { status: opts.status } });
    const invoices = res.data.map(i => fmtInvoice(i, { items: opts.items ?? true }));
    const active = invoices.filter(i => i.status !== 'void');
    const byStatus: Record<string, number> = {};
    for (const i of invoices) byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
    return {
        filtros: { start_date: opts.startDate, end_date: opts.endDate, client_id: opts.clientId ?? null, status: opts.status ?? null },
        resumen: {
            cantidad: invoices.length,
            por_estado: byStatus,
            total: sum(active.map(i => i.total)),
            balance: sum(active.map(i => i.balance)),
        },
        ...withTruncation(res),
        invoices,
    };
}

export async function openInvoices(opts: { since?: string; clientId?: string; minBalance?: number }) {
    await ensureClient(opts.clientId);
    const data = await alegra.listOpenInvoices(opts);
    const invoices = data.map(i => fmtInvoice(i)).sort((a, b) => a.date.localeCompare(b.date) || Number(a.id) - Number(b.id));
    return {
        filtros: { since: opts.since ?? null, client_id: opts.clientId ?? null, min_balance: opts.minBalance ?? 0.01 },
        resumen: { cantidad: invoices.length, total_balance: sum(invoices.map(i => i.balance)) },
        invoices,
    };
}

export async function getContactDetail(id: string, withBalances = true) {
    const c = await alegra.getContact(id);
    const internal = (c.internalContacts ?? []).map((ic: any) => ({
        name: [ic.name, ic.lastName].filter(Boolean).join(' '),
        email: ic.email ?? null,
        phone: ic.phone ?? null,
        mobile: ic.mobile ?? null,
    }));
    const emails = [...new Set([c.email, ...internal.map((ic: any) => ic.email)].flatMap((e: string | null) => (e ?? '').split(/[;,\s]+/)).filter(Boolean))];
    let balances: any = undefined;
    if (withBalances) {
        const [open, advances] = await Promise.all([alegra.listOpenInvoices({ clientId: id }), clientAdvanceBalance(id)]);
        balances = {
            saldo_cartera: sum(open.map((i: any) => Number(i.balance))),
            facturas_abiertas: open.length,
            saldo_anticipos: advances,
        };
    }
    return {
        ...clientRef(c),
        identificationObject: c.identificationObject ?? null,
        status: c.status,
        type: c.type,
        emails,
        phonePrimary: c.phonePrimary ?? null,
        phoneSecondary: c.phoneSecondary ?? null,
        mobile: c.mobile ?? null,
        fax: c.fax ?? null,
        address: c.address ?? null,
        term: c.term ? { id: String(c.term.id), name: c.term.name, days: Number(c.term.days ?? 0) } : null,
        seller: c.seller ? { id: String(c.seller.id), name: c.seller.name } : null,
        priceList: c.priceList ? { id: String(c.priceList.id), name: c.priceList.name } : null,
        creditLimit: c.creditLimit ?? null,
        statementAttached: c.statementAttached ?? null,
        observations: c.observations ?? null,
        internalContacts: internal,
        ...(balances && { balances }),
    };
}
