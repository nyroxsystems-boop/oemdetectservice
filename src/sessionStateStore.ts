import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

export interface StorageStateWriter {
  storageState(options: { path: string }): Promise<unknown>;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Keep browser cookies and bearer state private even with a permissive umask. */
export async function preparePrivateStorageState(statePath: string): Promise<void> {
  const directory = path.dirname(statePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  if (await exists(statePath)) await chmod(statePath, 0o600);
}

/**
 * Playwright writes storage state directly to the requested path. Write to a
 * private sibling first and rename atomically so crashes never leave a partial
 * credential file at the canonical location.
 */
export async function persistPrivateStorageState(
  writer: StorageStateWriter,
  statePath: string,
): Promise<void> {
  await preparePrivateStorageState(statePath);
  const temporaryPath = path.join(
    path.dirname(statePath),
    `.storage-state-${process.pid}-${randomUUID()}.partial`,
  );
  try {
    await writer.storageState({ path: temporaryPath });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, statePath);
    await chmod(statePath, 0o600);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}
