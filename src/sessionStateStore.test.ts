import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  persistPrivateStorageState,
  preparePrivateStorageState,
  type StorageStateWriter,
} from './sessionStateStore';

function permissions(mode: number): number {
  return mode & 0o777;
}

test('hardens an existing browser-session directory and file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'partsunion-session-state-'));
  const statePath = path.join(directory, 'state.json');
  try {
    await writeFile(statePath, '{"cookies":[]}', { mode: 0o644 });
    await chmod(directory, 0o755);

    await preparePrivateStorageState(statePath);

    assert.equal(permissions((await stat(directory)).mode), 0o700);
    assert.equal(permissions((await stat(statePath)).mode), 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('publishes storage state atomically with private permissions', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'partsunion-session-state-'));
  const statePath = path.join(directory, 'state.json');
  const writer: StorageStateWriter = {
    async storageState({ path: destination }) {
      await writeFile(destination, '{"cookies":[{"name":"session"}]}', { mode: 0o644 });
    },
  };
  try {
    await persistPrivateStorageState(writer, statePath);

    assert.equal(await readFile(statePath, 'utf8'), '{"cookies":[{"name":"session"}]}');
    assert.equal(permissions((await stat(statePath)).mode), 0o600);
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.partial')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('preserves the previous state when Playwright persistence fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'partsunion-session-state-'));
  const statePath = path.join(directory, 'state.json');
  const writer: StorageStateWriter = {
    async storageState({ path: destination }) {
      await writeFile(destination, 'partial', { mode: 0o644 });
      throw new Error('browser context failed');
    },
  };
  try {
    await writeFile(statePath, 'previous', { mode: 0o600 });
    await assert.rejects(persistPrivateStorageState(writer, statePath), /browser context failed/);

    assert.equal(await readFile(statePath, 'utf8'), 'previous');
    assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.partial')), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
