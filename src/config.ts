import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // PartsLink24 credentials
  pl24: {
    companyId: process.env.PL24_COMPANY_ID || '',   // Firmenkennung / ID (e.g. "de-388960")
    username: process.env.PL24_USERNAME || '',        // Benutzername
    password: process.env.PL24_PASSWORD || '',        // Passwort
    baseUrl: 'https://www.partslink24.com',
  },

  // Server
  port: parseInt(process.env.PORT || '4100', 10),

  // Browser
  headless: process.env.HEADLESS !== 'false',

  // Rate limiting
  requestDelayMs: parseInt(process.env.REQUEST_DELAY_MS || '3000', 10),

  // Cache
  cacheTtlSeconds: parseInt(process.env.CACHE_TTL_SECONDS || '2592000', 10), // 30 days
};
