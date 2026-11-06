import { open } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

export function localPath(root: string, key: string): string {
  const base = resolve(root), path = resolve(base, key);
  if (!path.startsWith(base + sep)) throw new Error(`Invalid artifact key: ${key}`);
  return path;
}

/** Bound allocation from the opened descriptor, not a stale earlier path stat. */
export function readLocalFile(path: string, maxBytes: number, expectedBytes?: number): Promise<Buffer> {
  return readFileBytes(path, maxBytes, expectedBytes);
}

/** The callback borrows one buffer through its awaited completion. */
export function createLocalFileReader(maxBytes: number) {
  checkByteBudget(maxBytes);
  const workspace: { bytes?: Buffer } = {};
  let busy = false;
  return async function read<T>(path: string, expectedBytes: number | undefined, consume: (bytes: Buffer) => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (busy) throw new Error('Local file buffer is in use');
    busy = true;
    try {
      const bytes = await readFileBytes(path, maxBytes, expectedBytes, signal, workspace);
      signal?.throwIfAborted();
      const result = await consume(bytes);
      signal?.throwIfAborted();
      return result;
    } finally { busy = false; }
  };
}

function checkByteBudget(maxBytes: number, expectedBytes?: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes))) throw new Error('Invalid local file byte budget');
}

async function readFileBytes(path: string, maxBytes: number, expectedBytes?: number, signal?: AbortSignal, workspace?: { bytes?: Buffer }): Promise<Buffer> {
  checkByteBudget(maxBytes, expectedBytes);
  signal?.throwIfAborted();
  const file = await open(path, 'r');
  try {
    signal?.throwIfAborted();
    const before = await file.stat(), size = before.size;
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1 || size > maxBytes || (expectedBytes !== undefined && size !== expectedBytes)) throw new Error(`Local file exceeds byte budget or changed length: ${path}`);
    signal?.throwIfAborted();
    const bytes = workspace ? (workspace.bytes ??= Buffer.allocUnsafe(maxBytes)).subarray(0, size) : Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      signal?.throwIfAborted();
      const result = await file.read(bytes, offset, size - offset, offset);
      signal?.throwIfAborted();
      if (!result.bytesRead) throw new Error(`Short local file read: ${path}`);
      offset += result.bytesRead;
    }
    const after = await file.stat();
    // A read can move ctime when Linux updates atime. Content changes move mtime.
    if (after.size !== size || after.mtimeMs !== before.mtimeMs) throw new Error(`Local file changed during read: ${path}`);
    signal?.throwIfAborted();
    return bytes;
  } finally { await file.close(); }
}
