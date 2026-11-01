import { open } from 'node:fs/promises';
import { PMTiles } from 'pmtiles';

export { Compression, TileType } from 'pmtiles';

/** A bounded local range source shared by archive admission and differential evidence. */
export async function openArchive(path: string) {
  const file = await open(path, 'r');
  try {
    const size = (await file.stat()).size;
    const reader = new PMTiles({
      getKey: () => path,
      async getBytes(offset, length) {
        if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size || !Number.isSafeInteger(length) || length <= 0 || length > 16 * 1024 * 1024) throw new Error('Invalid archive range');
        const data = Buffer.alloc(Math.min(length, size - offset));
        const { bytesRead } = await file.read(data, 0, data.length, offset);
        if (bytesRead !== data.length) throw new Error('Short archive read');
        return { data: data.buffer.slice(data.byteOffset, data.byteOffset + bytesRead) };
      }
    });
    return { reader, close: () => file.close() };
  } catch (error) { await file.close(); throw error; }
}
