#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as alegra from './alegra.js';
import { reconcilePos } from './reconcile.js';
import { createInvoicePayment, createAdvancePayment } from './payments.js';

const server = new McpServer({ name: 'mcp-alegra', version: '0.1.0' });

const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Fecha YYYY-MM-DD');

server.registerTool('test_connection', {
    description: 'Verifica la conexión con Alegra y devuelve los datos de la empresa',
}, async () => {
    const c: any = await alegra.getCompany();
    return json({ ok: true, name: c.name, identification: c.identification });
});

server.registerTool('list_invoices', {
    description: 'Lista todas las facturas de venta de una fecha (pagina automáticamente)',
    inputSchema: { date: dateSchema },
}, async ({ date }) => json(await alegra.listInvoicesByDate(date)));

server.registerTool('get_invoice', {
    description: 'Obtiene el detalle de una factura por su ID de Alegra',
    inputSchema: { id: z.string() },
}, async ({ id }) => json(await alegra.getInvoice(id)));

server.registerTool('list_payments', {
    description: 'Lista todos los pagos recibidos de una fecha',
    inputSchema: { date: dateSchema },
}, async ({ date }) => json(await alegra.listPaymentsByDate(date)));

server.registerTool('list_credit_notes', {
    description: 'Lista todas las notas de crédito de una fecha',
    inputSchema: { date: dateSchema },
}, async ({ date }) => json(await alegra.listCreditNotesByDate(date)));

server.registerTool('list_number_templates', {
    description: 'Lista las numeraciones (prefijos) configuradas en Alegra',
}, async () => json(await alegra.listNumberTemplates()));

server.registerTool('list_bank_accounts', {
    description: 'Lista las cuentas de banco / caja configuradas en Alegra',
}, async () => json(await alegra.listBankAccounts()));

server.registerTool('search_contacts', {
    description: 'Busca clientes en Alegra por nombre, código o identificación',
    inputSchema: { query: z.string() },
}, async ({ query }) => json((await alegra.searchContacts(query)).map((c: any) => ({ id: c.id, name: c.name, identification: c.identification, email: c.email }))));

server.registerTool('list_open_invoices', {
    description: 'Lista facturas abiertas (con saldo pendiente) desde una fecha',
    inputSchema: { since: dateSchema },
}, async ({ since }) => json((await alegra.listOpenInvoices(since)).map((i: any) => ({
    id: i.id, number: i.numberTemplate?.number, date: i.date, client: i.client?.name, total: i.total, balance: i.balance,
}))));

const voucherSchema = z.object({
    fact: z.string().describe('Nº FACT del datafono, ej. "001047"'),
    time: z.string().regex(/^\d{2}:\d{2}$/).describe('Hora HH:MM'),
    amount: z.number(),
    terminal: z.string().optional().describe('MBK30033 (crédito) o 321551 (Clave)'),
    lote: z.string().optional(),
    card: z.string().optional().describe('Marca y últimos 4, ej. "VISA 2246"'),
    auth: z.string().optional(),
});

server.registerTool('reconcile_pos', {
    description: 'Concilia las transacciones del cierre del datafono BAC (todos los lotes del día) contra los pagos con tarjeta ' +
        'registrados en Alegra en la cuenta BAC. Empareja por Nº de voucher anotado y luego por monto + hora. ' +
        'Devuelve emparejados, discrepancias, vouchers sin pago (con facturas abiertas candidatas) y pagos sin voucher.',
    inputSchema: { date: dateSchema, vouchers: z.array(voucherSchema) },
    annotations: { readOnlyHint: true },
}, async ({ date, vouchers }) => json(await reconcilePos(date, vouchers)));

server.registerTool('create_invoice_payment', {
    description: 'Registra el pago de una factura abierta (ej. un voucher del datafono identificado). ' +
        'Por defecto es SIMULACIÓN: devuelve el payload sin crear nada. Solo crea el pago con dry_run=false, ' +
        'después de que el usuario confirme.',
    inputSchema: {
        invoice_id: z.string().describe('ID interno de Alegra de la factura (no el número)'),
        date: dateSchema.describe('Fecha del cobro (la del cierre)'),
        amount: z.number().optional().describe('Por defecto, el saldo de la factura'),
        payment_method: z.string().optional().describe('Por defecto credit-card'),
        bank_account_id: z.string().optional().describe('Por defecto BAC Internat. Bank (10)'),
        anotation: z.string().optional().describe('Usar la suggestedAnotation de reconcile_pos'),
        observations: z.string().optional(),
        dry_run: z.boolean().default(true),
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
}, async (a) => json(await createInvoicePayment({
    invoiceId: a.invoice_id, date: a.date, amount: a.amount, paymentMethod: a.payment_method,
    bankAccountId: a.bank_account_id, anotation: a.anotation, observations: a.observations, dryRun: a.dry_run,
})));

server.registerTool('create_advance_payment', {
    description: 'Registra un anticipo/abono de un cliente sin factura (ej. 50% de reserva de sala de eventos), ' +
        'contra la cuenta "Avances y anticipos recibidos". Por defecto es SIMULACIÓN; solo crea el pago con ' +
        'dry_run=false, después de que el usuario confirme.',
    inputSchema: {
        client_id: z.string().describe('ID del cliente en Alegra (usar search_contacts)'),
        amount: z.number(),
        date: dateSchema.describe('Fecha del cobro'),
        observations: z.string().optional().describe('Concepto, ej. "50% Abono reserva sala de eventos 01-10-2026"'),
        anotation: z.string().optional().describe('Referencia del voucher, ej. la suggestedAnotation de reconcile_pos'),
        payment_method: z.string().optional().describe('Por defecto credit-card'),
        bank_account_id: z.string().optional().describe('Por defecto BAC Internat. Bank (10)'),
        dry_run: z.boolean().default(true),
    },
    annotations: { destructiveHint: false, readOnlyHint: false },
}, async (a) => json(await createAdvancePayment({
    clientId: a.client_id, amount: a.amount, date: a.date, observations: a.observations, anotation: a.anotation,
    paymentMethod: a.payment_method, bankAccountId: a.bank_account_id, dryRun: a.dry_run,
})));

await server.connect(new StdioServerTransport());
