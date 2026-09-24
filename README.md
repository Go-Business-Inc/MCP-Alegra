# MCP-Alegra

MCP local para consultar Alegra (MY OFFICE PANAMA INC) y conciliar el cierre del datafono BAC.

## Configuración

```bash
npm install
cp .env.example .env   # pegar ALEGRA_TOKEN (solo la primera vez: sobrescribe el .env)
npm run test:connection
```

Registrar en Claude Code (guía completa en [INSTALL.md](INSTALL.md)):

```bash
claude mcp add alegra --scope user -- npx tsx "$(pwd)/src/index.ts"
```

## Herramientas

| Herramienta | Tipo | Uso |
|---|---|---|
| `test_connection` | lectura | Verifica credenciales |
| `list_invoices`, `get_invoice`, `list_payments`, `list_credit_notes` | lectura | Consultas por fecha / ID |
| `list_open_invoices`, `search_contacts` | lectura | Facturas con saldo, buscar clientes |
| `list_number_templates`, `list_bank_accounts` | lectura | Catálogos |
| `reconcile_pos` | lectura | Concilia vouchers del cierre BAC vs. pagos con tarjeta en la cuenta BAC |
| `create_invoice_payment` | escritura | Registra el pago de una factura abierta |
| `create_advance_payment` | escritura | Registra un anticipo sin factura (cuenta *Avances y anticipos recibidos*) |

Las herramientas de escritura corren en **simulación** (`dry_run: true`) por defecto y devuelven el payload.
Solo crean el pago con `dry_run: false`.

## Conciliación

`reconcile_pos` empareja en tres pasos:

1. **Voucher**: nº anotado en el pago (`Según POS BAC 1053 del ...`), que es el FACT del datafono.
2. **Monto + hora**: monto exacto y hora de la factura a ≤ 3 h del voucher.
3. **Solo monto**: un único voucher y un único pago con ese monto (se marca para revisión).

Los vouchers sin pago traen facturas abiertas con saldo igual al monto y una anotación sugerida.

Desde terminal: `npm run reconcile -- 2026-09-18` lee `data/cierres/2026-09-18.json`
(arreglo de `{ fact, time, amount, terminal, lote, card, auth }`).

Registrar un pago desde terminal: `npm run pay-invoice -- <invoiceId> <fecha> <monto> "<anotación>" [--confirm]`.
