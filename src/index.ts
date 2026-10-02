#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as alegra from './alegra.js';
import { reconcilePos } from './reconcile.js';
import { createInvoicePayment, createAdvancePayment } from './payments.js';
import { listAdvances, advanceBalancesByClient } from './advances.js';
import { warmAdvanceCache } from './advance-cache.js';
import { clientStatement } from './statement.js';
import * as q from './queries.js';

const server = new McpServer({ name: 'mcp-alegra', version: '0.2.0' });

// JSON compacto: los listados grandes (facturas con ítems) pesan la mitad sin sangría
const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: alegra.scrubSecrets(JSON.stringify(data)) }] });
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Fecha en formato YYYY-MM-DD').describe('Fecha YYYY-MM-DD');
const clientIdSchema = z.string().regex(/^\d+$/, 'client_id es el id numérico del cliente en Alegra (use search_contacts)').describe('ID del cliente en Alegra (usar search_contacts)');
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// Devuelve los errores como texto claro para Claude, sin credenciales
function safe<A>(handler: (args: A) => Promise<unknown>) {
    return async (args: A) => {
        try {
            return json(await handler(args));
        } catch (e: any) {
            return { isError: true, content: [{ type: 'text' as const, text: alegra.scrubSecrets(e?.message ?? String(e)) }] };
        }
    };
}

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
    description: 'Lista las facturas abiertas con saldo pendiente (excluye las de saldo 0 aunque Alegra las tenga en estado open). ' +
        'Filtros opcionales: fecha de emisión desde, cliente y saldo mínimo (ej. min_balance=1 para separar centavos de redondeo). ' +
        'Incluye vencimiento, cliente, vendedor y centro de costo, y el total de cartera.',
    inputSchema: {
        since: dateSchema.optional().describe('Solo facturas emitidas desde esta fecha (YYYY-MM-DD)'),
        client_id: clientIdSchema.optional(),
        min_balance: z.number().min(0).optional().describe('Saldo mínimo a incluir. Por defecto 0.01'),
    },
    annotations: readOnly,
}, safe(({ since, client_id, min_balance }) => q.openInvoices({ since, clientId: client_id, minBalance: min_balance })));

server.registerTool('list_invoices_range', {
    description: 'Facturas de venta de un periodo (máx. 1 año), de cualquier estado (open, closed, void), con totales, saldo e ítems. ' +
        'Filtros opcionales por cliente y estado. Recorre todas las páginas (tope 2,000; avisa si se trunca).',
    inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        client_id: clientIdSchema.optional(),
        status: z.enum(['open', 'closed', 'void', 'draft']).optional(),
        include_items: z.boolean().optional().describe('Incluir los ítems de cada factura. Por defecto true; use false en periodos largos'),
    },
    annotations: readOnly,
}, safe(a => q.listInvoicesRange({ startDate: a.start_date, endDate: a.end_date, clientId: a.client_id, status: a.status, items: a.include_items ?? true })));

server.registerTool('list_payments_range', {
    description: 'Pagos recibidos (type=in) o egresos (type=out) en un rango de fechas (máx. 1 año), opcionalmente de un cliente. ' +
        'Por pago: número, fecha, monto, estado, método, cuenta bancaria, cliente, anotación, facturas pagadas y categorías ' +
        '(behavior ADVANCE_IN = anticipo). Recorre todas las páginas (tope 2,000; avisa si se trunca).',
    inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        client_id: clientIdSchema.optional(),
        type: z.enum(['in', 'out']).optional().describe('in = pagos recibidos, out = egresos. Por defecto ambos'),
    },
    annotations: readOnly,
}, safe(({ start_date, end_date, client_id, type }) => q.listPaymentsRange({ startDate: start_date, endDate: end_date, clientId: client_id, type })));

server.registerTool('list_credit_notes_range', {
    description: 'Notas de crédito en un rango de fechas (máx. 1 año), opcionalmente de un cliente, con las facturas a las que se aplicó cada una.',
    inputSchema: { start_date: dateSchema, end_date: dateSchema, client_id: clientIdSchema.optional() },
    annotations: readOnly,
}, safe(({ start_date, end_date, client_id }) => q.listCreditNotesRange({ startDate: start_date, endDate: end_date, clientId: client_id })));

server.registerTool('list_advances', {
    description: 'Anticipos recibidos (pagos a la cuenta "Avances y anticipos recibidos", behavior ADVANCE_IN) con cuánto se aplicó a facturas ' +
        'y cuánto queda por facturar (saldo_por_facturar), según las aplicaciones registradas en las facturas y los comprobantes ' +
        'contables de la cuenta. Con client_id consulta en vivo todo el historial del cliente; sin cliente usa la copia local ' +
        'del historial (se actualiza sola cada 10 minutos) y por defecto lista los últimos 90 días.',
    inputSchema: {
        client_id: clientIdSchema.optional(),
        start_date: dateSchema.optional(),
        end_date: dateSchema.optional(),
        only_pending: z.boolean().optional().describe('Solo anticipos con saldo por facturar'),
        refresh: z.boolean().optional().describe('Actualizar ya la copia local con lo último de Alegra'),
    },
    annotations: readOnly,
}, safe(a => listAdvances({ clientId: a.client_id, startDate: a.start_date, endDate: a.end_date, onlyPending: a.only_pending, refresh: a.refresh })));

server.registerTool('advance_balances_by_client', {
    description: 'Saldo de anticipos por facturar por cliente a una fecha (solo clientes con saldo distinto de 0): total de anticipos, ' +
        'total aplicado, saldo y fecha del anticipo pendiente más antiguo. Incluye la conciliación contra el saldo de la cuenta ' +
        '"Avances y anticipos recibidos". Usa la copia local del historial (se actualiza sola cada 10 minutos).',
    inputSchema: {
        as_of_date: dateSchema.optional().describe('Fecha de corte. Por defecto hoy'),
        refresh: z.boolean().optional().describe('Actualizar ya la copia local con lo último de Alegra'),
    },
    annotations: readOnly,
}, safe(a => advanceBalancesByClient({ asOf: a.as_of_date, refresh: a.refresh })));

server.registerTool('client_statement', {
    description: 'Estado de cuenta de un cliente en un periodo (máx. 1 año): facturas, pagos, notas de crédito, anticipos recibidos, ' +
        'aplicaciones de anticipos y asientos, en orden de fecha con saldo corrido de cartera y de anticipos; saldo inicial, ' +
        'saldo final y verificación contra el saldo de las facturas abiertas.',
    inputSchema: { client_id: clientIdSchema, start_date: dateSchema, end_date: dateSchema },
    annotations: readOnly,
}, safe(a => clientStatement(a.client_id, a.start_date, a.end_date)));

server.registerTool('get_contact', {
    description: 'Datos completos de un cliente: nombre, identificación, correos, teléfonos (phonePrimary, phoneSecondary, mobile), ' +
        'dirección, plazo de pago, vendedor y contactos internos, más su saldo de cartera y de anticipos.',
    inputSchema: {
        id: clientIdSchema,
        include_balances: z.boolean().optional().describe('Calcular saldos de cartera y anticipos. Por defecto true'),
    },
    annotations: readOnly,
}, safe(a => q.getContactDetail(a.id, a.include_balances ?? true)));

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
// Pone al día la copia local de anticipos sin bloquear el arranque
warmAdvanceCache().catch(() => { /* se reintenta en la primera consulta */ });
