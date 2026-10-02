// Descarga completa del historial de anticipos a la caché local (data/cache/advances.json).
// El servidor lo hace solo en segundo plano; esto sirve para dejarla lista de antemano.
// Uso: npm run sync-advances
import { fullSyncNow } from '../src/advance-cache.js';

const t0 = Date.now();
const r = await fullSyncNow();
console.log(`Listo en ${Math.round((Date.now() - t0) / 1000)} s: ${r.payments} pagos de anticipo, ${r.lines} líneas contables, ${r.invoicesWithAdvances} facturas con anticipos aplicados.`);
