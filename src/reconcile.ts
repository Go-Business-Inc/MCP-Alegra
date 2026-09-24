// Conciliación del cierre del datafono BAC contra los pagos registrados en Alegra.
import * as alegra from './alegra.js';

export interface Voucher {
    fact: string;          // Nº FACT del datafono (ej. "001047")
    time: string;          // HH:MM
    amount: number;
    terminal?: string;     // MBK30033 (crédito) | 321551 (Clave)
    lote?: string;
    card?: string;         // marca + últimos 4, ej. "VISA 2246"
    auth?: string;
}

// Cuánto se aleja (en minutos) la hora de la factura de la hora del voucher para aceptarla por monto
const TIME_TOLERANCE_MIN = 180;
// Ventana hacia atrás para buscar facturas abiertas que un voucher podría estar pagando
const OPEN_INVOICE_LOOKBACK_DAYS = 90;

const round2 = (n: number) => Math.round(n * 100) / 100;
const toMinutes = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number);
    return h * 60 + m;
};
const normFact = (f: string) => String(Number(f));

// "Según POS BAC 1053 del ..." | "Según POS 1051 BAC del ..." -> "1053" / "1051"
export function voucherFromAnotation(text: string | null | undefined): string | null {
    if (!text) return null;
    const m = text.match(/POS\s*(?:BAC\s*)?(\d{3,6})/i) ?? text.match(/(\d{3,6})\s*BAC/i);
    return m ? normFact(m[1]) : null;
}

// Monto que se escribió en la anotación ("por $160.00"), para detectar errores de digitación
function amountFromAnotation(text: string | null | undefined): number | null {
    const m = text?.match(/por\s*\$\s*([\d,]+(?:\.\d+)?)/i);
    return m ? Number(m[1].replace(/,/g, '')) : null;
}

function addDays(date: string, days: number) {
    const d = new Date(date + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
}

// Forma estándar de anotar el voucher en el pago (mantiene el formato que ya usa el equipo)
export function voucherAnotation(v: Voucher, date: string) {
    const [y, m, d] = date.split('-');
    const extra = [v.lote && `Lote ${v.lote}`, v.card, v.auth && `Auth ${v.auth}`, v.terminal && `Terminal ${v.terminal}`]
        .filter(Boolean).join(', ');
    return `Según POS BAC ${normFact(v.fact)} del ${d}-${m}-${y} por $${v.amount.toFixed(2)}${extra ? ` (${extra})` : ''}`;
}

export async function reconcilePos(date: string, vouchers: Voucher[], bankAccountId = alegra.BAC_ACCOUNT_ID) {
    const [payments, dayInvoices] = await Promise.all([
        alegra.listPaymentsByDate(date),
        alegra.listInvoicesByDate(date),
    ]);

    // Pagos con tarjeta que entraron a la cuenta BAC ese día
    const cardPayments = (payments as any[]).filter(p =>
        p.type === 'in' && String(p.bankAccount?.id) === String(bankAccountId) && /card/.test(p.paymentMethod ?? ''));

    // Hora de cada pago = hora de la factura que paga (los pagos no traen hora propia)
    const invoiceCache = new Map<string, any>((dayInvoices as any[]).map(i => [String(i.id), i]));
    for (const p of cardPayments) {
        for (const ref of p.invoices ?? []) {
            if (!invoiceCache.has(String(ref.id))) invoiceCache.set(String(ref.id), await alegra.getInvoice(ref.id));
        }
    }
    const rows = cardPayments.map(p => {
        const inv = (p.invoices ?? []).map((r: any) => invoiceCache.get(String(r.id))).filter(Boolean);
        const first = inv[0];
        return {
            paymentId: String(p.id),
            amount: round2(p.amount),
            anotation: p.anotation ?? '',
            voucherRef: voucherFromAnotation(p.anotation),
            anotationAmount: amountFromAnotation(p.anotation),
            client: p.client?.name ?? first?.client?.name ?? null,
            invoices: inv.map((i: any) => ({ id: String(i.id), number: i.numberTemplate?.number, date: i.date, datetime: i.datetime, originApp: i.originApp ?? 'WEB' })),
            minutes: first?.date === date && first?.datetime ? toMinutes(first.datetime.slice(11, 16)) : null,
        };
    });

    const matched: any[] = [];
    const usedPayments = new Set<string>();
    const pendingVouchers: Voucher[] = [];

    // 1) Por número de voucher anotado en el pago
    for (const v of vouchers) {
        const row = rows.find(r => !usedPayments.has(r.paymentId) && r.voucherRef === normFact(v.fact));
        if (row) {
            usedPayments.add(row.paymentId);
            matched.push({ by: 'voucher', voucher: v, payment: row });
        } else {
            pendingVouchers.push(v);
        }
    }

    // 2) Por monto exacto + hora más cercana (asignación codiciosa por menor diferencia)
    const candidates: { v: Voucher; row: typeof rows[number]; diff: number }[] = [];
    for (const v of pendingVouchers) {
        for (const row of rows) {
            if (usedPayments.has(row.paymentId) || row.voucherRef) continue;
            if (round2(row.amount) !== round2(v.amount)) continue;
            const diff = row.minutes === null ? TIME_TOLERANCE_MIN : Math.abs(row.minutes - toMinutes(v.time));
            if (diff <= TIME_TOLERANCE_MIN) candidates.push({ v, row, diff });
        }
    }
    candidates.sort((a, b) => a.diff - b.diff);
    const usedVouchers = new Set<string>();
    for (const c of candidates) {
        if (usedVouchers.has(c.v.fact) || usedPayments.has(c.row.paymentId)) continue;
        usedVouchers.add(c.v.fact);
        usedPayments.add(c.row.paymentId);
        const ambiguous = candidates.filter(o => o.v.fact === c.v.fact && o.row.paymentId !== c.row.paymentId).length > 0;
        matched.push({ by: 'monto+hora', minutesApart: c.diff, ambiguous, voucher: c.v, payment: c.row });
    }

    // 3) Monto único: si queda un solo voucher y un solo pago con ese monto, se emparejan aunque las
    //    horas estén lejos (pasa cuando la factura se hace en la app POS horas después del cobro)
    const leftVouchers = pendingVouchers.filter(v => !usedVouchers.has(v.fact));
    const leftRows = rows.filter(r => !usedPayments.has(r.paymentId) && !r.voucherRef);
    for (const v of leftVouchers) {
        const sameV = leftVouchers.filter(o => round2(o.amount) === round2(v.amount));
        const sameR = leftRows.filter(r => round2(r.amount) === round2(v.amount) && !usedPayments.has(r.paymentId));
        if (sameV.length !== 1 || sameR.length !== 1) continue;
        const row = sameR[0];
        usedVouchers.add(v.fact);
        usedPayments.add(row.paymentId);
        const minutesApart = row.minutes === null ? null : Math.abs(row.minutes - toMinutes(v.time));
        matched.push({ by: 'solo monto', minutesApart, ambiguous: false, voucher: v, payment: row });
    }

    // Discrepancias dentro de lo emparejado
    const discrepancies = matched.flatMap(m => {
        const issues: string[] = [];
        if (round2(m.payment.amount) !== round2(m.voucher.amount)) issues.push(`monto del pago $${m.payment.amount} ≠ voucher $${m.voucher.amount}`);
        if (m.payment.anotationAmount !== null && round2(m.payment.anotationAmount) !== round2(m.payment.amount)) {
            issues.push(`la anotación dice $${m.payment.anotationAmount} pero el pago es $${m.payment.amount}`);
        }
        const late = m.payment.invoices.find((i: any) => i.date !== date);
        if (late) issues.push(`factura ${late.number} fechada ${late.date} (cobro el ${date})`);
        if (m.by === 'solo monto') issues.push(`emparejado solo por monto; la factura se registró ${m.minutesApart ?? '?'} min después/antes del cobro — revisar`);
        return issues.length ? [{ fact: m.voucher.fact, paymentId: m.payment.paymentId, issues }] : [];
    });

    // 3) Vouchers sin pago: sugerir facturas abiertas con saldo igual al monto
    const unmatchedVouchers = pendingVouchers.filter(v => !usedVouchers.has(v.fact));
    let openInvoices: any[] = [];
    if (unmatchedVouchers.length) openInvoices = await alegra.listOpenInvoices(addDays(date, -OPEN_INVOICE_LOOKBACK_DAYS));
    const vouchersWithoutPayment = unmatchedVouchers.map(v => ({
        voucher: v,
        suggestedAnotation: voucherAnotation(v, date),
        openInvoiceCandidates: openInvoices
            .filter(i => round2(i.balance) === round2(v.amount))
            .map(i => ({ id: String(i.id), number: i.numberTemplate?.number, date: i.date, client: i.client?.name, balance: i.balance })),
    }));

    const paymentsWithoutVoucher = rows.filter(r => !usedPayments.has(r.paymentId));

    const totalVouchers = round2(vouchers.reduce((s, v) => s + v.amount, 0));
    const totalAlegra = round2(rows.reduce((s, r) => s + r.amount, 0));
    return {
        date,
        summary: {
            vouchers: vouchers.length,
            totalVouchers,
            alegraCardPaymentsBAC: rows.length,
            totalAlegra,
            difference: round2(totalVouchers - totalAlegra),
            matched: matched.length,
            vouchersWithoutPayment: vouchersWithoutPayment.length,
            paymentsWithoutVoucher: paymentsWithoutVoucher.length,
            discrepancies: discrepancies.length,
        },
        matched: matched.map(m => ({
            fact: m.voucher.fact, time: m.voucher.time, amount: m.voucher.amount, by: m.by,
            ...(m.minutesApart !== undefined && { minutesApart: m.minutesApart, ambiguous: m.ambiguous }),
            paymentId: m.payment.paymentId, invoices: m.payment.invoices.map((i: any) => `${i.number} (${i.originApp} ${i.datetime?.slice(11, 16) ?? i.date})`), client: m.payment.client,
        })),
        discrepancies,
        vouchersWithoutPayment,
        paymentsWithoutVoucher,
    };
}
