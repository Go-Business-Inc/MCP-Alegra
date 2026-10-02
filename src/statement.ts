// Estado de cuenta de un cliente: cartera (cuentas por cobrar) y anticipos, con saldo corrido.
import * as alegra from './alegra.js';
import { loadApplications, type Application } from './advances.js';
import { money, sum, isZero, today, checkRange, clientRef, shortNumber, setInvoicePrefixes } from './format.js';

const ADV = alegra.ADVANCE_CATEGORY_ID;
const CXC = alegra.RECEIVABLE_CATEGORY_ID;

interface Movement {
    date: string;
    tipo: 'factura' | 'pago' | 'retencion' | 'nota_credito' | 'anticipo' | 'aplicacion_anticipo' | 'devolucion_anticipo' | 'asiento';
    documento: string | null;
    id: string;
    detalle: string;
    cartera: number;    // + aumenta lo que debe el cliente, - lo disminuye
    anticipos: number;  // + anticipo recibido, - anticipo aplicado o devuelto
}

// Orden dentro de un mismo día: primero lo que genera deuda, después lo que la cancela
const ORDER: Record<Movement['tipo'], number> = { factura: 0, anticipo: 1, pago: 2, retencion: 3, nota_credito: 4, aplicacion_anticipo: 5, asiento: 6, devolucion_anticipo: 7 };

const portion = (p: any, categoryId: string) =>
    sum((p.categories ?? []).filter((c: any) => String(c.id) === categoryId).map((c: any) => Number(c.total)));

export async function clientStatement(clientId: string, start: string, end: string) {
    checkRange(start, end);
    const contact = await alegra.getContact(clientId);
    const upTo = { client_id: clientId, date_beforeOrNow: end };
    const lineCut = end < today() ? { fromDate: '2000-01-01', toDate: end } : {};

    setInvoicePrefixes(await alegra.invoicePrefixes());
    const [invoices, payments, creditNotes, applications, advLines, cxcLines] = await Promise.all([
        alegra.alegraList('/invoices', upTo, Infinity),
        alegra.alegraList('/payments', upTo, Infinity),
        alegra.alegraList('/credit-notes', upTo, Infinity),
        loadApplications(clientId),
        alegra.listJournalLines({ category_id: ADV, client_id: clientId, ...lineCut }),
        alegra.listJournalLines({ category_id: CXC, client_id: clientId, ...lineCut }),
    ]);

    const moves: Movement[] = [];

    for (const i of invoices.data) {
        if (i.status === 'void' || i.status === 'draft') continue;
        moves.push({
            date: i.date, tipo: 'factura', documento: i.numberTemplate?.number ?? null, id: String(i.id),
            detalle: `Vence ${i.dueDate ?? i.date}`, cartera: money(i.total), anticipos: 0,
        });
        // Retenciones que hizo el cliente (ej. 50% del ITBMS): reducen el saldo de la factura al cobrarla
        const retained = sum((i.retentions ?? []).map((r: any) => Number(r.amount ?? 0)));
        if (retained) {
            const paidOn = (i.payments ?? []).map((p: any) => p.date).sort()[0] ?? i.date;
            moves.push({
                date: paidOn, tipo: 'retencion', documento: i.numberTemplate?.number ?? null, id: String(i.id),
                detalle: `Retención ${(i.retentions ?? []).map((r: any) => r.name).join(', ')} sobre la factura ${i.numberTemplate?.number}`,
                cartera: -retained, anticipos: 0,
            });
        }
    }

    for (const p of payments.data) {
        if (p.status === 'void') continue;
        const number = p.numberTemplate?.fullNumber ?? p.number ?? null;
        const onInvoices = sum((p.invoices ?? []).map((i: any) => Number(i.amount)));
        const advance = portion(p, ADV);
        if (p.type === 'in' && onInvoices) {
            moves.push({
                date: p.date, tipo: 'pago', documento: number, id: String(p.id),
                detalle: `${p.paymentMethod ?? ''} a facturas ${(p.invoices ?? []).map((i: any) => shortNumber(i.number)).join(', ')}`.trim(),
                cartera: -onInvoices, anticipos: 0,
            });
        }
        if (p.type === 'in' && advance) {
            moves.push({ date: p.date, tipo: 'anticipo', documento: number, id: String(p.id), detalle: (p.observations || p.anotation || p.paymentMethod || '').split('\n')[0], cartera: 0, anticipos: advance });
        }
        if (p.type === 'out' && advance) {
            moves.push({ date: p.date, tipo: 'devolucion_anticipo', documento: number, id: String(p.id), detalle: (p.observations || p.anotation || '').split('\n')[0], cartera: 0, anticipos: -advance });
        }
    }

    for (const c of creditNotes.data) {
        if (c.status === 'void' || c.status === 'draft') continue;
        const applied = (c.invoices ?? []).map((i: any) => shortNumber(i.fullNumber ?? i.number, i.prefix)).join(', ');
        moves.push({
            date: c.date, tipo: 'nota_credito', documento: c.numberTemplate?.number ?? null, id: String(c.id),
            detalle: applied ? `Aplicada a facturas ${applied}` : 'Sin aplicar a facturas', cartera: -money(c.total), anticipos: 0,
        });
    }

    const appsUpTo = applications.filter(a => a.date <= end);
    for (const a of appsUpTo) {
        moves.push({
            date: a.date, tipo: 'aplicacion_anticipo', documento: a.invoice.number, id: a.paymentId,
            detalle: `Anticipo (pago ${a.paymentId}) aplicado a la factura ${a.invoice.number}`, cartera: -a.amount, anticipos: -a.amount,
        });
    }

    // Comprobantes contables sobre 5031 o CxC del cliente. Los que generó Alegra al aplicar un
    // anticipo ya están en las aplicaciones; el resto (asientos manuales) se agrega aparte.
    const journals = new Map<string, { adv: number; cxc: number }>();
    for (const [lines, key] of [[advLines, 'adv'], [cxcLines, 'cxc']] as const) {
        for (const l of lines) {
            if (l.status === 'void') continue;
            const j = journals.get(l.idJournal) ?? { adv: 0, cxc: 0 };
            j[key] = money(j[key] + Number(l.debit ?? 0) - Number(l.credit ?? 0));
            journals.set(l.idJournal, j);
        }
    }
    const unmatched = matchApplications(journals, appsUpTo);
    const manual = await Promise.all(unmatched.map(async ([idJournal, j]) => {
        const detail: any = await alegra.alegraGet(`/journals/${idJournal}`).catch(() => null);
        return { idJournal, j, detail };
    }));
    for (const { idJournal, j, detail } of manual) {
        if (detail?.status === 'void') continue;
        moves.push({
            date: detail?.date ?? end, tipo: 'asiento', documento: detail?.id ? `Comprobante ${detail.id}` : null, id: String(detail?.id ?? idJournal),
            detalle: (detail?.observations ?? 'Comprobante contable').split('\n')[0], cartera: j.cxc, anticipos: -j.adv,
        });
    }

    // Alegra ignora el corte de fecha en algunos listados por cliente: se aplica aquí
    for (let k = moves.length - 1; k >= 0; k--) if (moves[k].date > end) moves.splice(k, 1);

    moves.sort((a, b) => a.date.localeCompare(b.date) || ORDER[a.tipo] - ORDER[b.tipo] || a.id.localeCompare(b.id, undefined, { numeric: true }));

    let cartera = 0;
    let anticipos = 0;
    const rows: any[] = [];
    for (const m of moves) {
        cartera = money(cartera + m.cartera);
        anticipos = money(anticipos + m.anticipos);
        if (m.date < start) continue;
        rows.push({
            ...m,
            cargo: m.cartera > 0 ? m.cartera : 0,
            abono: m.cartera < 0 ? -m.cartera : 0,
            saldo_cartera: cartera,
            saldo_anticipos: anticipos,
            saldo_neto: money(cartera - anticipos),
        });
    }
    const before = moves.filter(m => m.date < start);
    const opening = { saldo_cartera: sum(before.map(m => m.cartera)), saldo_anticipos: sum(before.map(m => m.anticipos)) };

    // Cuadre: con corte a hoy, la cartera debe ser la suma de saldos de las facturas abiertas
    const checks: any = {};
    const notes: string[] = [];
    if (end >= today()) {
        const openBalance = sum(invoices.data.filter((i: any) => i.status === 'open').map((i: any) => Number(i.balance ?? 0)));
        checks.saldo_facturas_abiertas = openBalance;
        checks.diferencia_cartera = money(cartera - openBalance);
        if (!isZero(checks.diferencia_cartera)) {
            notes.push('La cartera calculada no coincide con la suma de saldos de facturas abiertas: puede haber notas de crédito o pagos sin aplicar a una factura (saldo a favor) o movimientos que la API no expone.');
        }
    } else {
        notes.push('Con corte anterior a hoy no se puede cuadrar contra el saldo actual de las facturas.');
    }
    if (invoices.truncated || payments.truncated || creditNotes.truncated) notes.push('Algún listado superó el tope de registros: el estado de cuenta puede estar incompleto.');

    return {
        client: { ...clientRef(contact), email: contact.email ?? null },
        periodo: { start_date: start, end_date: end },
        saldo_inicial: { ...opening, saldo_neto: money(opening.saldo_cartera - opening.saldo_anticipos) },
        movimientos: rows,
        saldo_final: { saldo_cartera: cartera, saldo_anticipos: anticipos, saldo_neto: money(cartera - anticipos) },
        totales_periodo: {
            cargos: sum(rows.map(r => r.cargo)),
            abonos: sum(rows.map(r => r.abono)),
            anticipos_recibidos: sum(rows.filter(r => r.anticipos > 0).map(r => r.anticipos)),
            anticipos_aplicados_o_devueltos: sum(rows.filter(r => r.anticipos < 0).map(r => -r.anticipos)),
        },
        verificacion: checks,
        notas: notes,
        leyenda: 'saldo_cartera = lo que el cliente debe en facturas; saldo_anticipos = dinero recibido aún sin aplicar a facturas; saldo_neto = cartera - anticipos.',
    };
}

// Empareja cada aplicación de anticipo con el comprobante automático que la generó (mismo monto
// debitado en 5031). Devuelve los comprobantes que no corresponden a ninguna aplicación.
function matchApplications(journals: Map<string, { adv: number; cxc: number }>, apps: Application[]) {
    const pool = [...journals.entries()];
    const used = new Set<string>();
    for (const a of apps) {
        const hit = pool.find(([id, j]) => !used.has(id) && isZero(j.adv - a.amount) && isZero(j.cxc + a.amount))
            ?? pool.find(([id, j]) => !used.has(id) && isZero(j.adv - a.amount));
        if (hit) used.add(hit[0]);
    }
    return pool.filter(([id, j]) => !used.has(id) && !(isZero(j.adv) && isZero(j.cxc)));
}
