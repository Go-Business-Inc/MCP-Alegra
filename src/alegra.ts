import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// El .env vive en la raíz del repo; se resuelve relativo a este archivo porque Claude
// lanza el MCP desde cualquier carpeta.
config({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });

const BASE_URL = 'https://api.alegra.com/api/v1';
// Alegra devuelve máximo 30 registros por página
const PAGE_LIMIT = 30;

function authHeader(): string {
    const user = process.env.ALEGRA_USER;
    const token = process.env.ALEGRA_TOKEN;
    if (!user || !token) {
        throw new Error('Faltan ALEGRA_USER / ALEGRA_TOKEN en el entorno (.env)');
    }
    return 'Basic ' + Buffer.from(`${user}:${token}`).toString('base64');
}

export class AlegraError extends Error {
    constructor(public status: number, public body: unknown) {
        super(`Alegra HTTP ${status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    }
}

export async function alegraGet<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(BASE_URL + path);
    for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await fetch(url, {
        headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* respuesta no JSON */ }
    if (!res.ok) throw new AlegraError(res.status, body);
    return body as T;
}

// Recorre todas las páginas de un listado de Alegra
export async function alegraGetAll<T = any>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T[]> {
    const all: T[] = [];
    let start = 0;
    while (true) {
        const page = await alegraGet<T[]>(path, { ...params, start, limit: PAGE_LIMIT });
        all.push(...page);
        if (page.length < PAGE_LIMIT) break;
        start += PAGE_LIMIT;
    }
    return all;
}

export async function alegraPost<T = any>(path: string, payload: unknown): Promise<T> {
    const res = await fetch(BASE_URL + path, {
        method: 'POST',
        headers: { Authorization: authHeader(), Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body: any = text;
    try { body = JSON.parse(text); } catch { /* respuesta no JSON */ }
    if (!res.ok) throw new AlegraError(res.status, body);
    return body as T;
}

// Cuentas y categorías de MyOffice (sobrescribibles por .env)
export const BAC_ACCOUNT_ID = process.env.ALEGRA_BAC_ACCOUNT_ID ?? '10';        // BAC Internat. Bank
export const ADVANCE_CATEGORY_ID = process.env.ALEGRA_ADVANCE_CATEGORY_ID ?? '5031'; // Avances y anticipos recibidos

// Facturas abiertas (con saldo) desde una fecha; recorre de la más nueva a la más vieja
export async function listOpenInvoices(sinceDate: string): Promise<any[]> {
    const all: any[] = [];
    let start = 0;
    while (true) {
        const page = await alegraGet<any[]>('/invoices', { status: 'open', order_direction: 'DESC', start, limit: PAGE_LIMIT });
        all.push(...page.filter(i => i.date >= sinceDate));
        if (page.length < PAGE_LIMIT || page[page.length - 1].date < sinceDate) break;
        start += PAGE_LIMIT;
    }
    return all;
}

export const getCompany = () => alegraGet('/company');
export const getPayment = (id: string | number) => alegraGet(`/payments/${id}`);
export const searchContacts = (query: string) => alegraGet<any[]>('/contacts', { query, start: 0, limit: 30 });
export const createPayment = (payload: unknown) => alegraPost('/payments', payload);
export const getInvoice = (id: string | number) => alegraGet(`/invoices/${id}`);
export const listInvoicesByDate = (date: string) => alegraGetAll('/invoices', { date, order_direction: 'ASC' });
export const listPaymentsByDate = (date: string) => alegraGetAll('/payments', { date, order_direction: 'ASC' });
export const listCreditNotesByDate = (date: string) => alegraGetAll('/credit-notes', { date, order_direction: 'ASC' });
export const listNumberTemplates = () => alegraGet('/number-templates');
export const listBankAccounts = () => alegraGet('/bank-accounts');
export const listSellers = () => alegraGet('/sellers');
