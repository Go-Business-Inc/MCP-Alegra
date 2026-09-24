# Instalación de MCP-Alegra con Claude

Guía para instalar el MCP de Alegra de MyOffice en tu máquina y usarlo desde Claude Code o Claude Desktop.

> **Instrucción para Claude:** si un usuario te pide instalar este MCP, sigue estos pasos en orden.
> **Nunca escribas el token de Alegra tú mismo**: pídele al usuario que lo pegue en el archivo `.env` y espera su confirmación.

## Requisitos

- Node.js 20 o superior (`node -v`)
- Git con acceso al repo `Go-Business-Inc/MCP-Alegra`
- El token de la API de Alegra de MyOffice (pídeselo al administrador; **no está en el repo**)

## 1. Clonar e instalar

```bash
git clone https://github.com/Go-Business-Inc/MCP-Alegra.git
cd MCP-Alegra
npm install
```

## 2. Configurar credenciales

```bash
cp .env.example .env
```

Abre `.env` y completa:

```
ALEGRA_USER=admin@myoffice.com.pa
ALEGRA_TOKEN=<token de Alegra>
```

> El `cp` sobrescribe el `.env`: ejecútalo **solo la primera vez**. `.env` está en `.gitignore` y nunca se sube al repo.

Opcionales (tienen valores por defecto para MyOffice):

```
ALEGRA_BAC_ACCOUNT_ID=10          # cuenta "BAC Internat. Bank"
ALEGRA_ADVANCE_CATEGORY_ID=5031   # cuenta "Avances y anticipos recibidos"
```

## 3. Probar la conexión

```bash
npm run test:connection
```

Debe responder `Conexión OK` y el nombre `MY OFFICE PANAMA INC`.

## 4. Registrar el MCP

### Claude Code

Desde la carpeta del repo:

```bash
claude mcp add alegra --scope user -- npx tsx "$(pwd)/src/index.ts"
```

Verifica con `claude mcp list` (debe aparecer `alegra ... ✓ Connected`).

### Claude Desktop

Edita `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) o
`%APPDATA%\Claude\claude_desktop_config.json` (Windows) y agrega, con la ruta absoluta de tu clon:

```json
{
  "mcpServers": {
    "alegra": {
      "command": "npx",
      "args": ["tsx", "/RUTA/ABSOLUTA/MCP-Alegra/src/index.ts"]
    }
  }
}
```

Reinicia Claude Desktop.

## 5. Uso

Ejemplos de lo que puedes pedirle a Claude:

- *"Trae las facturas de Alegra del 18 de septiembre"*
- *"Aquí está la foto del cierre del datafono del 18, concílialo con Alegra"* → Claude lee los vouchers y usa `reconcile_pos`
- *"Registra el pago del voucher 1047 contra la factura que sugeriste"* → `create_invoice_payment`
- *"Registra un anticipo de $150 de WITS LATAM por el 50% de la sala de eventos"* → `search_contacts` + `create_advance_payment`

Las herramientas que crean pagos corren en **simulación** por defecto: Claude te muestra lo que enviaría y solo
lo crea en Alegra cuando tú confirmas.

### Registrar un pago desde la terminal

```bash
npm run pay-invoice -- <invoiceId> <YYYY-MM-DD> <monto> "<anotación>"            # simulación
npm run pay-invoice -- <invoiceId> <YYYY-MM-DD> <monto> "<anotación>" --confirm  # crea el pago
```

`invoiceId` es el ID interno de Alegra (no el número de factura); lo devuelven `reconcile_pos` y `list_open_invoices`.

## Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `Faltan ALEGRA_USER / ALEGRA_TOKEN` | `.env` vacío o sin guardar, o se volvió a ejecutar `cp .env.example .env` |
| `Alegra HTTP 401` | Token incorrecto o revocado |
| El MCP no aparece en Claude | Ruta relativa en la configuración: usa la ruta absoluta a `src/index.ts` |
