# Cómo instalar el MCP de Alegra (guía fácil)

Este MCP le da a Claude acceso a **Alegra de MyOffice**: puede consultar facturas y pagos, conciliar el cierre
del datafono BAC y registrar pagos o anticipos (siempre pidiéndote confirmación antes).

Tiempo estimado: **10 minutos**. No necesitas saber programar: Claude hace casi todo.

---

## Antes de empezar, ten a mano

| Qué | Dónde lo consigues |
|---|---|
| ✅ La app **Claude** (de escritorio) instalada | [claude.ai/download](https://claude.ai/download) |
| ✅ Acceso al repositorio en GitHub `Go-Business-Inc/MCP-Alegra` | Pídeselo al administrador de GitHub de Go Business |
| ✅ El **token de la API de Alegra** | Pídeselo al administrador. **No lo compartas por chat ni correo sin cifrar.** |
| ✅ **Node.js** instalado | Si no lo tienes, Claude te ayuda a instalarlo en el paso 1 |

---

## Paso 1 — Pídele a Claude que lo instale

1. Abre la app **Claude** y ve a la pestaña **Code**.
2. Inicia una sesión nueva en la carpeta donde guardas tus proyectos (por ejemplo `Documentos`).
3. Copia y pega este mensaje:

   > Instala el MCP de Alegra siguiendo la sección "Instrucciones para Claude" del archivo INSTALL.md de
   > https://github.com/Go-Business-Inc/MCP-Alegra

4. Claude te irá pidiendo permiso para algunas acciones (clonar, instalar, editar configuración).
   **Acepta** las que correspondan a la instalación.

## Paso 2 — Pega el token (esto lo haces tú)

Claude se detendrá y te pedirá el token. **Claude no escribe el token por ti**, por seguridad.

1. Claude te abrirá un archivo llamado `.env` en TextEdit. Se ve así:
   ```
   ALEGRA_USER=admin@myoffice.com.pa
   ALEGRA_TOKEN=
   ```
2. Pega el token **justo después** de `ALEGRA_TOKEN=` (sin espacios ni comillas).
3. Guarda con **⌘ + S** y cierra TextEdit.
4. Vuelve a Claude y escribe: **listo**.

Claude probará la conexión. Debe decir **"Conexión OK — MY OFFICE PANAMA INC"**.

## Paso 3 — Reinicia la app

Cierra la app Claude **por completo** (⌘ + Q) y vuelve a abrirla. Sin esto, las herramientas no aparecen.

## Paso 4 — Pruébalo

En una sesión nueva (en **Code**, en el **chat** o en **Cowork**), escribe:

> Prueba la conexión con Alegra

Si responde con el nombre de la empresa, **ya está**. 🎉

---

## ¿Qué le puedo pedir?

| Quieres… | Escríbele a Claude… |
|---|---|
| Ver facturas de un día | *"Trae las facturas de Alegra del 18 de septiembre"* |
| Conciliar el cierre del datafono | *"Aquí está la foto del cierre del datafono del 18, concílialo con Alegra"* (adjunta la foto de los vouchers y el cierre) |
| Registrar un pago identificado | *"Registra el pago del voucher 1047 contra la factura que sugeriste"* |
| Registrar un abono sin factura | *"Registra un anticipo de $150 de WITS LATAM por el 50% de la sala de eventos, voucher 1052"* |
| Ver facturas pendientes de cobro | *"¿Qué facturas abiertas hay desde el 1 de agosto?"* |

**Sobre los pagos:** Claude primero te muestra una **simulación** (qué va a registrar, a qué factura, por cuánto).
Solo lo crea en Alegra cuando tú dices que sí. La primera vez, la app te preguntará si permites la herramienta:
puedes elegir "Permitir siempre".

---

## Si algo sale mal

| Lo que ves | Qué hacer |
|---|---|
| Claude dice *"Faltan ALEGRA_USER / ALEGRA_TOKEN"* | El token no quedó guardado. Abre el `.env` otra vez, pégalo, guarda con ⌘ + S. |
| *"Alegra HTTP 401"* | El token está mal copiado o ya no sirve. Pide uno nuevo al administrador. |
| Las herramientas de Alegra no aparecen | Cierra la app con ⌘ + Q y ábrela de nuevo. Si sigue igual, pídele a Claude: *"Revisa que el MCP de Alegra esté registrado según INSTALL.md"*. |
| Aparece en Code pero no en el chat/Cowork (o al revés) | Están configurados por separado. Pídele a Claude que lo registre en ambos (paso 6 de las instrucciones). |

## Actualizar a una versión nueva

Pídele a Claude: *"Actualiza el MCP de Alegra"*. (Hace `git pull` + `npm install` en la carpeta del MCP y te pide reiniciar la app.)

---
---

## Instrucciones para Claude

> Sigue estos pasos en orden. Explícale al usuario cada paso en lenguaje sencillo.
> **Nunca escribas, pegues ni muestres el token de Alegra.** El usuario lo pega en `.env`; tú solo verificas que exista.

1. **Node.js ≥ 20.** Ejecuta `node -v`. Si no existe o es menor a 20, guía al usuario para instalarlo
   (instalador LTS de [nodejs.org](https://nodejs.org)) y vuelve a verificar.

2. **Clonar.** Pregunta dónde guardarlo (sugiere `~/Documents/MCP-Alegra`). Clona
   `https://github.com/Go-Business-Inc/MCP-Alegra.git`. Si ya existe la carpeta, haz `git pull` en vez de clonar.
   Si falla por permisos de GitHub, el usuario necesita acceso al repo: díselo y detente.

3. **Instalar y compilar.** En la carpeta del repo: `npm install` (compila automáticamente a `dist/`).
   Verifica que exista `dist/index.js`.

4. **Credenciales.** Si `.env` **no existe**, cópialo desde `.env.example` (si ya existe, **no lo sobrescribas**).
   Ábrelo para el usuario con `open -e .env` y pídele que pegue el token después de `ALEGRA_TOKEN=` y guarde.
   Espera a que diga "listo". Verifica sin mostrar el valor: `grep -c '^ALEGRA_TOKEN=.\+' .env` debe dar `1`.

5. **Probar.** `npm run test:connection` → debe imprimir `Conexión OK` y `MY OFFICE PANAMA INC`.

6. **Registrar el servidor en los DOS lugares** (Code y la app de escritorio usan archivos distintos).
   Usa **rutas absolutas**: `NODE` = salida de `which node`; `REPO` = ruta absoluta del clon.
   Haz un respaldo de cada archivo antes de editarlo (`cp archivo archivo.bak-mcp-alegra`) y conserva
   las demás entradas de `mcpServers` intactas.

   - **Claude Code** → `~/.claude.json`, dentro de `mcpServers`
     (o, si existe el CLI `claude`: `claude mcp add alegra --scope user -- NODE REPO/dist/index.js`):
     ```json
     "alegra": { "type": "stdio", "command": "NODE", "args": ["REPO/dist/index.js"], "env": {} }
     ```
   - **Claude Desktop (chat y Cowork)** → macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`;
     Windows: `%APPDATA%\Claude\claude_desktop_config.json`. Dentro de `mcpServers` (créalo si no existe):
     ```json
     "alegra": { "command": "NODE", "args": ["REPO/dist/index.js"] }
     ```
   Valida que ambos archivos sigan siendo JSON válido después de editarlos.

   *Por qué ruta absoluta de node y `dist/`:* la app de escritorio no hereda el PATH de la terminal
   (no encuentra `npx` si Node se instaló con nvm/Homebrew). El `.env` se lee siempre desde la carpeta del repo.

7. **Cierre.** Pide al usuario reiniciar la app (⌘ + Q) y probar en una sesión nueva con
   *"Prueba la conexión con Alegra"*.

**Actualizar:** en `REPO`, `git pull && npm install`; luego reiniciar la app.

**Herramientas de escritura** (`create_invoice_payment`, `create_advance_payment`): úsalas primero con
`dry_run: true`, muestra la simulación y solo llama con `dry_run: false` tras la confirmación explícita del usuario.
