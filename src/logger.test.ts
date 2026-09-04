import assert from 'node:assert/strict';
import test from 'node:test';
import { safeUrlForLog } from './logger';

test('safeUrlForLog removes query credentials and fragments', () => {
  assert.equal(
    safeUrlForLog('https://catalog.example/vehicle/overview?access_token=secret#session-token'),
    'https://catalog.example/vehicle/overview',
  );
});

test('safeUrlForLog fails closed for invalid and non-HTTP URLs', () => {
  assert.equal(safeUrlForLog('not a URL?token=secret'), '[invalid URL]');
  assert.equal(safeUrlForLog('data:text/plain,secret'), '[data URL]');
});

test('safeUrlForLog masks opaque Partslink catalogue paths that can encode a VIN', () => {
  assert.equal(
    safeUrlForLog('https://www.partslink24.com/pl24-app/mercedes_parts/reversible-vin-payload/search?q=door'),
    'https://www.partslink24.com/pl24-app/mercedes_parts/[CATALOG_PATH]',
  );
});
