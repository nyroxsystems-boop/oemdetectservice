import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractFromPartslinkSearchPayload,
  extractFromText,
  partslinkSearchQuery,
} from './scraper';

test('extracts a Partslink OEM without swallowing the following field label', () => {
  const results = extractFromText(`
Bildtafel 11_9979
Teilenummer 11 42 7 508 966
Benennung Ölfilter mit Kunststoffdeckel
HG 11
FG 30
  `);

  assert.equal(results.length, 1);
  assert.equal(results[0].oem, '11 42 7 508 966');
  assert.equal(results[0].description, 'Ölfilter mit Kunststoffdeckel');
});

test('supports Partslink layouts with labels and values on separate lines', () => {
  const results = extractFromText(`
Bildtafel
11_9979
Teilenummer
11 42 7 508 968
Benennung
Ölfilterdeckel
HG
11
FG
30
  `);

  assert.equal(results.length, 1);
  assert.equal(results[0].oem, '11 42 7 508 968');
  assert.equal(results[0].description, 'Ölfilterdeckel');
});

test('does not parse the asynchronous result-table header as an OEM', () => {
  const results = extractFromText(`
Teilenummer
Benennung (Kategorie)
Bildtafel
HG
FG
  `);

  assert.deepEqual(results, []);
});

test('does not confirm an OE merely because it appears in the search text', () => {
  const results = extractFromText(`
Suche: 8R0941285E
Teilenummer
Benennung (Kategorie)
Bildtafel
  `);

  assert.deepEqual(results, []);
});

test('extracts the exact observed Mercedes Partslink JSON search contract', () => {
  const results = extractFromPartslinkSearchPayload({
    search: { wid: 'search', path: 'redacted' },
    demo: false,
    data: {
      records: [{
        p5goto: { pid: 'part', ws: 'redacted' },
        values: {
          mg: '54',
          sg: '09',
          partno: 'A 642 905 01 00',
          description: 'Differenzdrucksensor',
        },
      }],
    },
  });

  assert.deepEqual(results, [{
    oem: 'A 642 905 01 00',
    description: 'Differenzdrucksensor',
  }]);
});

test('treats an observed empty Mercedes JSON record list as a confirmed empty result', () => {
  assert.deepEqual(extractFromPartslinkSearchPayload({ data: { records: [] } }), []);
});

test('fails closed for non-empty Partslink JSON records without the observed fields', () => {
  assert.equal(extractFromPartslinkSearchPayload({
    data: { records: [{ values: { partno: 'A 642 905 01 00' } }] },
  }), null);
  assert.equal(extractFromPartslinkSearchPayload({ data: { records: [{}] } }), null);
});

test('searches Partslink by component instead of noisy axle and side words', () => {
  assert.equal(partslinkSearchQuery('Koppelstange vorne links'), 'Koppelstange');
  assert.equal(partslinkSearchQuery('Bremsschlauch VA rechts'), 'Bremsschlauch');
  assert.equal(partslinkSearchQuery('Fensterheber hinten Fahrerseite'), 'Fensterheber');
});

test('maps workshop slang to the manufacturer-catalog search term', () => {
  assert.equal(partslinkSearchQuery('Penelstütze vorne rechts'), 'Pendelstütze');
  assert.equal(partslinkSearchQuery('Bremssattelhalter vorne links'), 'Bremsträger');
  assert.equal(partslinkSearchQuery('Domlager hinten'), 'Stützlager');
  assert.equal(partslinkSearchQuery('Stabigummi VA'), 'Gummilager Stabilisator');
  assert.equal(partslinkSearchQuery('Schwenklager vorne links'), 'Achsschenkel');
  assert.equal(partslinkSearchQuery('Spurstangenkopf links'), 'Spurstange');
  assert.equal(partslinkSearchQuery('Feststellbremsseil hinten links'), 'Handbremsbowdenzug');
  assert.equal(partslinkSearchQuery('Rückleuchte hinten links'), 'Heckleuchte');
  assert.equal(partslinkSearchQuery('Fensterhebermotor vorne links'), 'Fensterheberantrieb');
  assert.equal(partslinkSearchQuery('Fensterheber ohne Motor vorne links'), 'Fensterheber');
  assert.equal(partslinkSearchQuery('Kraftstoffpumpe im Tank'), 'Kraftstoffpumpe');
  assert.equal(partslinkSearchQuery('Hochdruckpumpe'), 'Hochdruckpumpe');
  assert.equal(partslinkSearchQuery('Bremsbelag Verschleißsensor vorne'), 'Bremsbelagfühler');
  assert.equal(partslinkSearchQuery('Bremsbelagverschleißsensor vorne'), 'Bremsbelagfühler');
  assert.equal(partslinkSearchQuery('Klimakondensator'), 'Kondensator');
});
