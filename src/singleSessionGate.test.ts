import assert from 'node:assert/strict';
import test from 'node:test';
import { SingleSessionGate } from './singleSessionGate';

test('serializes concurrent Partslink session operations', async () => {
  const gate = new SingleSessionGate();
  let active = 0;
  let maximumActive = 0;
  const order: string[] = [];

  const run = (label: string, delayMs: number) => gate.runExclusive(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push(`${label}:start`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    order.push(`${label}:end`);
    active -= 1;
    return label;
  });

  const values = await Promise.all([
    run('first', 20),
    run('second', 1),
    run('third', 1),
  ]);

  assert.deepEqual(values, ['first', 'second', 'third']);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, [
    'first:start',
    'first:end',
    'second:start',
    'second:end',
    'third:start',
    'third:end',
  ]);
});

test('releases the session gate after a failed operation', async () => {
  const gate = new SingleSessionGate();

  await assert.rejects(
    gate.runExclusive(async () => {
      throw new Error('probe failed');
    }),
    /probe failed/,
  );

  await assert.doesNotReject(
    gate.runExclusive(async () => 'recovered'),
  );
});
