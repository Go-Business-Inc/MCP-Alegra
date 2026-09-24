// Descarga facturas y pagos de un día y resume los campos útiles para detectar origen POS.
// Uso: npm run explore -- 2026-09-21
import { mkdirSync, writeFileSync } from 'node:fs';
import { listInvoicesByDate, listPaymentsByDate, listNumberTemplates } from '../src/alegra.js';

const date = process.argv[2] ?? '2026-09-21';
mkdirSync('data', { recursive: true });

const [invoices, payments, templates] = await Promise.all([
    listInvoicesByDate(date),
    listPaymentsByDate(date),
    listNumberTemplates(),
]);
writeFileSync(`data/invoices-${date}.json`, JSON.stringify(invoices, null, 2));
writeFileSync(`data/payments-${date}.json`, JSON.stringify(payments, null, 2));
writeFileSync(`data/number-templates.json`, JSON.stringify(templates, null, 2));

console.log(`Facturas: ${invoices.length} | Pagos: ${payments.length}`);

// Unión de todas las llaves presentes en las facturas
const keys = new Set<string>();
invoices.forEach((i: any) => Object.keys(i).forEach(k => keys.add(k)));
console.log('\nCampos de factura:', [...keys].sort().join(', '));

// Frecuencia de valores en campos candidatos
const tally = (label: string, fn: (i: any) => unknown) => {
    const m = new Map<string, number>();
    invoices.forEach((i: any) => {
        const v = JSON.stringify(fn(i) ?? null);
        m.set(v, (m.get(v) ?? 0) + 1);
    });
    console.log(`\n${label}:`);
    [...m.entries()].sort((a, b) => b[1] - a[1]).forEach(([v, n]) => console.log(`  ${n}x ${v}`));
};
tally('numberTemplate', i => i.numberTemplate && { id: i.numberTemplate.id, prefix: i.numberTemplate.prefix, name: i.numberTemplate.name });
tally('type', i => i.type);
tally('seller', i => i.seller?.name);
tally('warehouse', i => i.warehouse?.name);
tally('station / pos', i => i.station ?? i.pos ?? i.pointOfSale);
tally('saleCondition', i => i.saleCondition);
tally('paymentMethod', i => i.paymentMethod);
tally('paymentForm', i => i.paymentForm);
tally('status', i => i.status);
tally('stamp.legalStatus', i => i.stamp?.legalStatus);
tally('createdBy/user', i => i.createdBy ?? i.user);
tally('payments[].paymentMethod', i => (i.payments ?? []).map((p: any) => p.paymentMethod));
tally('originApp', i => i.originApp);

// Detalle por factura. Los pagos embebidos en la factura no traen la cuenta bancaria ni
// la anotación completa: se cruzan con /payments del día (los de otras fechas quedan sin cuenta).
const paymentsById = new Map(payments.map((p: any) => [String(p.id), p]));
console.log('\nDetalle (origen | hora | número | total | pagos método/cuenta/anotación):');
for (const i of invoices as any[]) {
    const pays = (i.payments ?? []).map((p: any) => {
        const full: any = paymentsById.get(String(p.id));
        const account = full?.bankAccount?.name ?? `(pago del ${p.date})`;
        const note = (full?.anotation ?? p.anotation ?? '').split('\n')[0].slice(0, 60);
        return `${p.paymentMethod}/${account}${note ? ` "${note}"` : ''}`;
    });
    console.log(`  ${(i.originApp ?? 'WEB').padEnd(4)} | ${i.datetime?.slice(11) ?? ''} | ${i.numberTemplate?.number ?? i.id} | ${i.total} | ${pays.join('; ') || 'SIN PAGO ENLAZADO'}`);
}
