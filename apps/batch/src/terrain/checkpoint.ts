import { createHash } from 'node:crypto';
import { putImmutable } from '../immutable-upload.js';
import { TERRAIN_BATCH_POINTS, type TerrainStorage } from './contract.js';

export const TERRAIN_CHECKPOINT_CELLS = TERRAIN_BATCH_POINTS * 16;
const HEADER_BYTES = 80;
const CELL_BYTES = 5;
const MAGIC = 0x43545641;
interface Window { identity: string; firstCell: number; count: number }

function key(window: Window): string {
  if (!/^[a-f0-9]{64}$/.test(window.identity) || !Number.isSafeInteger(window.firstCell) || window.firstCell < 0
      || window.firstCell > 0xffff_ffff || window.firstCell % TERRAIN_CHECKPOINT_CELLS !== 0
      || !Number.isSafeInteger(window.count) || window.count < 1 || window.count > TERRAIN_CHECKPOINT_CELLS) throw new Error('Invalid terrain checkpoint window');
  return `terrain/checkpoints/${window.identity}/w${window.firstCell / TERRAIN_CHECKPOINT_CELLS}.bin`;
}

function validateCells(heights: Uint8Array, valid: Uint8Array): void {
  const view = new DataView(heights.buffer, heights.byteOffset, heights.byteLength);
  for (let i = 0; i < valid.length; i++) {
    const value = view.getFloat32(i * 4, true);
    if (valid[i] > 1 || !Number.isFinite(value) || (!valid[i] && value !== 0)) throw new Error('Invalid terrain checkpoint cell');
  }
}

function slices(window: Window, heights: Uint8Array, valid: Uint8Array) {
  if (heights.length !== valid.length * 4 || window.firstCell + window.count > valid.length) throw new Error('Terrain checkpoint exceeds target arrays');
  return { heights: heights.subarray(window.firstCell * 4, (window.firstCell + window.count) * 4), valid: valid.subarray(window.firstCell, window.firstCell + window.count) };
}

/** Restore one complete source-verified window into its canonical packed offsets. */
export async function restoreTerrainCheckpoint(storage: TerrainStorage, window: Window, heights: Uint8Array, valid: Uint8Array, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const object = await storage.get(key(window), undefined, HEADER_BYTES + window.count * CELL_BYTES, signal);
  signal?.throwIfAborted();
  if (!object) return false;
  const bytes = Buffer.from(object.bytes.buffer, object.bytes.byteOffset, object.bytes.byteLength);
  if (bytes.length !== HEADER_BYTES + window.count * CELL_BYTES || object.etag !== `"${createHash('md5').update(bytes).digest('hex')}"`) throw new Error('Terrain checkpoint content digest mismatch');
  if (bytes.readUInt32LE(0) !== MAGIC || bytes.readUInt32LE(4) !== 1 || bytes.subarray(8, 40).toString('hex') !== window.identity
      || bytes.readUInt32LE(40) !== window.firstCell || bytes.readUInt32LE(44) !== window.count) throw new Error('Terrain checkpoint identity mismatch');
  const payload = bytes.subarray(HEADER_BYTES);
  if (!createHash('sha256').update(payload).digest().equals(bytes.subarray(48, HEADER_BYTES))) throw new Error('Terrain checkpoint payload hash mismatch');
  const elevation = payload.subarray(0, window.count * 4), validity = payload.subarray(window.count * 4);
  validateCells(elevation, validity);
  const destination = slices(window, heights, valid);
  destination.heights.set(elevation); destination.valid.set(validity);
  return true;
}

/** Commit the bounded binary window after every source sample has completed. */
export async function writeTerrainCheckpoint(storage: TerrainStorage, window: Window, heights: Uint8Array, valid: Uint8Array, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const objectKey = key(window), source = slices(window, heights, valid);
  validateCells(source.heights, source.valid);
  const bytes = Buffer.alloc(HEADER_BYTES + window.count * CELL_BYTES);
  bytes.writeUInt32LE(MAGIC, 0); bytes.writeUInt32LE(1, 4);
  Buffer.from(window.identity, 'hex').copy(bytes, 8);
  bytes.writeUInt32LE(window.firstCell, 40); bytes.writeUInt32LE(window.count, 44);
  bytes.set(source.heights, HEADER_BYTES); bytes.set(source.valid, HEADER_BYTES + window.count * 4);
  createHash('sha256').update(bytes.subarray(HEADER_BYTES)).digest().copy(bytes, 48);
  await putImmutable(storage, objectKey, bytes, 'application/octet-stream', signal);
}
