import assert from 'node:assert/strict';
import test from 'node:test';
import { productionConfigErrors } from './config';
import { secureEquals } from './httpSecurity';

test('secureEquals accepts only the exact non-empty API key', () => {
  const key = 'a'.repeat(32);
  assert.equal(secureEquals(key, key), true);
  assert.equal(secureEquals(`${key}x`, key), false);
  assert.equal(secureEquals('', key), false);
  assert.equal(secureEquals(key, ''), false);
});

test('production configuration fails closed for missing credentials', () => {
  const errors = productionConfigErrors({ NODE_ENV: 'production' });
  assert.ok(errors.some(error => error.includes('CATALOG_API_KEY')));
  assert.ok(errors.some(error => error.includes('PL24_COMPANY_ID')));
  assert.ok(errors.some(error => error.includes('PL24_USERNAME')));
  assert.ok(errors.some(error => error.includes('PL24_PASSWORD')));
  assert.ok(errors.some(error => error.includes('OEM_DATABASE_REQUIRED')));
  assert.ok(errors.some(error => error.includes('OEM_DATABASE_URL')));
});

test('production configuration accepts strong service credentials', () => {
  const errors = productionConfigErrors({
    NODE_ENV: 'production',
    CATALOG_API_KEY: 'catalog-api-key-with-more-than-32-characters',
    PL24_COMPANY_ID: 'de-123456',
    PL24_USERNAME: 'service-account',
    PL24_PASSWORD: 'strong-password-value',
    OEM_DATABASE_REQUIRED: 'true',
    OEM_DATABASE_URL: 'postgresql://catalog@database.internal:5432/oem',
    WWS_BOT_URL: 'https://bot.internal.example',
    ADMIN_TOKEN: 'admin-token-with-more-than-32-characters',
    CORS_ALLOWED_ORIGINS: 'https://admin.example',
  });
  assert.deepEqual(errors, []);
});

test('production configuration accepts admin only as a legitimate Partslink24 username', () => {
  const env = {
    NODE_ENV: 'production',
    CATALOG_API_KEY: 'catalog-api-key-with-more-than-32-characters',
    PL24_COMPANY_ID: 'de-123456',
    PL24_USERNAME: 'admin',
    PL24_PASSWORD: 'strong-password-value',
    OEM_DATABASE_REQUIRED: 'true',
    OEM_DATABASE_URL: 'postgresql://catalog@database.internal:5432/oem',
  };

  assert.deepEqual(productionConfigErrors(env), []);
  assert.ok(productionConfigErrors({ ...env, PL24_USERNAME: 'service-account', PL24_PASSWORD: 'admin' })
    .some(error => error.includes('PL24_PASSWORD')));
});

test('production configuration rejects insecure outbound and browser origins', () => {
  const errors = productionConfigErrors({
    NODE_ENV: 'production',
    CATALOG_API_KEY: 'catalog-api-key-with-more-than-32-characters',
    PL24_COMPANY_ID: 'de-123456',
    PL24_USERNAME: 'service-account',
    PL24_PASSWORD: 'strong-password-value',
    OEM_DATABASE_REQUIRED: 'true',
    OEM_DATABASE_URL: 'postgresql://catalog@database.internal:5432/oem',
    WWS_BOT_URL: 'http://bot.internal.example',
    ADMIN_TOKEN: 'admin-token-with-more-than-32-characters',
    CORS_ALLOWED_ORIGINS: 'http://admin.example',
  });
  assert.ok(errors.some(error => error.includes('WWS_BOT_URL')));
  assert.ok(errors.some(error => error.includes('CORS origin')));
});
