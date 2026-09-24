// Uso: npm run reconcile -- 2026-09-18 [data/cierres/2026-09-18.json]
import { readFileSync } from 'node:fs';
import { reconcilePos } from '../src/reconcile.js';

const date = process.argv[2];
const file = process.argv[3] ?? `data/cierres/${date}.json`;
const result = await reconcilePos(date, JSON.parse(readFileSync(file, 'utf8')));
console.log(JSON.stringify(result, null, 2));
