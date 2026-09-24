import { getCompany } from '../src/alegra.js';

const company: any = await getCompany();
console.log('Conexión OK');
console.log({ name: company.name, identification: company.identification, regime: company.regime, country: company.applicationVersion ?? company.country });
