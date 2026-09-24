// Registra el pago de una factura abierta desde la terminal.
// Uso: npm run pay-invoice -- <invoiceId> <fecha YYYY-MM-DD> <monto> "<anotación>" [--confirm]
// Sin --confirm solo muestra lo que se enviaría (simulación).
import { createInvoicePayment } from '../src/payments.js';

const [invoiceId, date, amount, anotation] = process.argv.slice(2).filter(a => a !== '--confirm');
const confirm = process.argv.includes('--confirm');
if (!invoiceId || !date || !amount) {
    console.error('Uso: npm run pay-invoice -- <invoiceId> <YYYY-MM-DD> <monto> "<anotación>" [--confirm]');
    process.exit(1);
}
const result = await createInvoicePayment({ invoiceId, date, amount: Number(amount), anotation, dryRun: !confirm });
console.log(JSON.stringify(result, null, 2));
if (!confirm) console.log('\nSIMULACIÓN: agrega --confirm para crear el pago en Alegra.');
