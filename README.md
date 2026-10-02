# MCP-Alegra

MCP local para consultar Alegra (MY OFFICE PANAMA INC) y conciliar el cierre del datafono BAC.

## Configuración

```bash
npm install
cp .env.example .env   # pegar ALEGRA_TOKEN (solo la primera vez: sobrescribe el .env)
npm run test:connection
```

`npm install` compila a `dist/`. El servidor se registra con la ruta absoluta de node y de `dist/index.js`,
tanto en Claude Code (`~/.claude.json`) como en Claude Desktop/Cowork (`claude_desktop_config.json`).
Guía paso a paso en [INSTALL.md](INSTALL.md).

## Herramientas

| Herramienta | Tipo | Uso |
|---|---|---|
| `test_connection` | lectura | Verifica credenciales |
| `list_invoices`, `get_invoice`, `list_payments`, `list_credit_notes` | lectura | Consultas por fecha / ID |
| `list_open_invoices` | lectura | Cartera: facturas con saldo > 0 (filtros `since`, `client_id`, `min_balance`) y total |
| `list_invoices_range`, `list_payments_range`, `list_credit_notes_range` | lectura | Por rango de fechas (máx. 1 año) y cliente; todas las páginas, tope 2,000 |
| `list_advances` | lectura | Anticipos con lo aplicado a facturas y el `saldo_por_facturar` de cada uno |
| `advance_balances_by_client` | lectura | Saldo de anticipos por cliente a una fecha, con conciliación de la cuenta 5031 |
| `client_statement` | lectura | Estado de cuenta: cartera y anticipos con saldo corrido |
| `get_contact`, `search_contacts` | lectura | Ficha completa del cliente con saldos; buscar clientes |
| `list_number_templates`, `list_bank_accounts` | lectura | Catálogos |
| `reconcile_pos` | lectura | Concilia vouchers del cierre BAC vs. pagos con tarjeta en la cuenta BAC |
| `create_invoice_payment` | escritura | Registra el pago de una factura abierta |
| `create_advance_payment` | escritura | Registra un anticipo sin factura (cuenta *Avances y anticipos recibidos*) |

Las herramientas de escritura corren en **simulación** (`dry_run: true`) por defecto y devuelven el payload.
Solo crean el pago con `dry_run: false`.

## Anticipos

En esta cuenta un anticipo es un pago sin factura con categoría 5031 *Avances y anticipos recibidos*.
Al aplicarlo en una factura, Alegra lo guarda en la factura (`advances[]`, solo con `fields=advances`) y
genera un comprobante contable automático (débito 5031 / crédito Cuentas por cobrar). El saldo por cliente
es el contable: pagos 5031 − débitos de comprobantes en 5031 (`/journals/entries`) − devoluciones. El
detalle por anticipo usa las aplicaciones de las facturas; lo que no tiene factura identificada (asientos
manuales) se reparte por antigüedad y sale como `aplicado_sin_detalle`.

Las consultas de todos los clientes usan una copia local en `data/cache/advances.json`, porque Alegra
tarda ~7 minutos en entregar el historial completo. El servidor la descarga la primera vez y una vez por
semana en segundo plano, y la pone al día (últimos días, ~10 s) cuando tiene más de 10 minutos. Las consultas
con `client_id` van siempre en vivo. Para prepararla de antemano: `npm run sync-advances`.

La API pública no expone el *Balance de prueba por tercero* (responde 403): `advance_balances_by_client`
devuelve `conciliacion.saldo_cuenta` para compararlo con ese reporte en Alegra.

## Conciliación POS

`reconcile_pos` empareja en tres pasos:

1. **Voucher**: nº anotado en el pago (`Según POS BAC 1053 del ...`), que es el FACT del datafono.
2. **Monto + hora**: monto exacto y hora de la factura a ≤ 3 h del voucher.
3. **Solo monto**: un único voucher y un único pago con ese monto (se marca para revisión).

Los vouchers sin pago traen facturas abiertas con saldo igual al monto y una anotación sugerida.

Desde terminal: `npm run reconcile -- 2026-09-18` lee `data/cierres/2026-09-18.json`
(arreglo de `{ fact, time, amount, terminal, lote, card, auth }`).

Registrar un pago desde terminal: `npm run pay-invoice -- <invoiceId> <fecha> <monto> "<anotación>" [--confirm]`.
