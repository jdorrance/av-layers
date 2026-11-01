import { open } from 'node:fs/promises';

/** Bound allocation from the opened descriptor, not a stale earlier path stat. */
export async function readLocalFile(path: string, maxBytes: number, expectedBytes?: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || (expectedBytes !== undefined && (!Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > maxBytes))) throw new Error('Invalid local file byte budget');
  const file = await open(path, 'r');
  try {
    const before = await file.stat(), size = before.size;
    if (!before.isFile() || !Number.isSafeInteger(size) || size < 1 || size > maxBytes || (expectedBytes !== undefined && size !== expectedBytes)) throw new Error(`Local file exceeds byte budget or changed length: ${path}`);
    const bytes = Buffer.alloc(size);
    for (let offset = 0; offset < size;) {
      const result = await file.read(bytes, offset, size - offset, offset);
      if (!result.bytesRead) throw new Error(`Short local file read: ${path}`);
      offset += result.bytesRead;
    }
    const after = await file.stat();
    if (after.size !== size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error(`Local file changed during read: ${path}`);
    return bytes;
  } finally { await file.close(); }
}
