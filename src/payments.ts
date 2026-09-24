// Creación de pagos en Alegra. Todo corre en modo simulación (dryRun) salvo que se pida lo contrario.
import * as alegra from './alegra.js';

export interface InvoicePaymentInput {
    invoiceId: string;
    amount?: number;          // por defecto, el saldo de la factura
    date: string;             // fecha del cobro (la del cierre), no la de la factura
    bankAccountId?: string;
    paymentMethod?: string;
    anotation?: string;
    observations?: string;
    dryRun?: boolean;
}

export async function createInvoicePayment(input: InvoicePaymentInput) {
    const inv: any = await alegra.getInvoice(input.invoiceId);
    const balance = Number(inv.balance ?? 0);
    const amount = input.amount ?? balance;
    if (inv.status !== 'open' || balance <= 0) {
        throw new Error(`La factura ${inv.numberTemplate?.number} no tiene saldo pendiente (status ${inv.status}, saldo ${balance})`);
    }
    if (amount <= 0 || amount - balance > 0.005) {
        throw new Error(`Monto $${amount} inválido: el saldo de la factura ${inv.numberTemplate?.number} es $${balance}`);
    }
    const payload = {
        type: 'in',
        date: input.date,
        bankAccount: Number(input.bankAccountId ?? alegra.BAC_ACCOUNT_ID),
        paymentMethod: input.paymentMethod ?? 'credit-card',
        client: { id: Number(inv.client.id) },
        invoices: [{ id: Number(inv.id), amount }],
        anotation: input.anotation ?? '',
        observations: input.observations ?? '',
    };
    const context = { invoice: inv.numberTemplate?.number, client: inv.client?.name, invoiceDate: inv.date, balanceBefore: balance, balanceAfter: Math.round((balance - amount) * 100) / 100 };
    if (input.dryRun !== false) return { dryRun: true, context, payload };
    const created: any = await alegra.createPayment(payload);
    return { dryRun: false, context, created: { id: created.id, number: created.number, amount: created.amount, date: created.date } };
}

export interface AdvancePaymentInput {
    clientId: string;
    amount: number;
    date: string;
    bankAccountId?: string;
    paymentMethod?: string;
    anotation?: string;
    observations?: string;   // ej. "50% Abono a reserva sala de eventos 1 de octubre 2026"
    dryRun?: boolean;
}

// Pago recibido sin factura, llevado a la cuenta pasivo "Avances y anticipos recibidos".
// Replica cómo el equipo ya registra los abonos (ver pago 20666).
export async function createAdvancePayment(input: AdvancePaymentInput) {
    if (!(input.amount > 0)) throw new Error('El monto del anticipo debe ser mayor a cero');
    const client: any = await alegra.alegraGet(`/contacts/${input.clientId}`);
    const payload = {
        type: 'in',
        date: input.date,
        bankAccount: Number(input.bankAccountId ?? alegra.BAC_ACCOUNT_ID),
        paymentMethod: input.paymentMethod ?? 'credit-card',
        client: { id: Number(client.id) },
        categories: [{ id: Number(alegra.ADVANCE_CATEGORY_ID), price: input.amount, quantity: 1, observations: input.observations ?? '' }],
        anotation: input.anotation ?? '',
        observations: input.observations ?? '',
    };
    const context = { client: client.name, category: 'Avances y anticipos recibidos' };
    if (input.dryRun !== false) return { dryRun: true, context, payload };
    const created: any = await alegra.createPayment(payload);
    return { dryRun: false, context, created: { id: created.id, number: created.number, amount: created.amount, date: created.date } };
}
