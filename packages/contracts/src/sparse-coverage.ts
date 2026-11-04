import { SAMPLE_BLOCK_SIZE } from './format.js';

const BLOCK_SIZE = SAMPLE_BLOCK_SIZE;
const MASK_BYTES = BLOCK_SIZE * BLOCK_SIZE / 8;
const HEADER_BYTES = 60;
const BLOCK_BYTES = 8 + 2 * MASK_BYTES;
const MAX_BYTES = 256 * 1024 * 1024;
const MAGIC = 0x31564353;

export interface SparseCoverage {
  width: number;
  height: number;
  wrapLongitude: boolean;
  gridHash: string;
  blockIds: Uint32Array;
  offsets: Uint32Array;
  output: Uint8Array;
  halo: Uint8Array;
}

function dimensions(width: number, height: number): { columns: number; blocks: number } {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height >= 0xffffffff) {
    throw new RangeError('Invalid sparse coverage dimensions');
  }
  const columns = Math.ceil(width / BLOCK_SIZE), blocks = columns * Math.ceil(height / BLOCK_SIZE);
  return { columns, blocks };
}

function popcount(value: number): number {
  value = value - ((value >>> 1) & 0x55);
  value = (value & 0x33) + ((value >>> 2) & 0x33);
  return (value + (value >>> 4)) & 0x0f;
}

export function createSparseCoverage(coverage: SparseCoverage): SparseCoverage {
  const { width, height, wrapLongitude, gridHash, blockIds, offsets, output, halo } = coverage;
  const { columns, blocks } = dimensions(width, height);
  if (typeof wrapLongitude !== 'boolean' || typeof gridHash !== 'string' || !/^[a-f0-9]{64}$/.test(gridHash) ||
      !(blockIds instanceof Uint32Array) || !(offsets instanceof Uint32Array) || !(output instanceof Uint8Array) || !(halo instanceof Uint8Array)) {
    throw new Error('Invalid sparse coverage metadata');
  }
  const count = blockIds.length;
  if (count > blocks || HEADER_BYTES + count * BLOCK_BYTES > MAX_BYTES || offsets.length !== count + 1 ||
      output.length !== count * MASK_BYTES || halo.length !== count * MASK_BYTES || offsets[0] !== 0) {
    throw new Error('Invalid sparse coverage directory length');
  }
  let active = 0;
  for (let block = 0; block < count; block++) {
    const id = blockIds[block];
    if (id >= blocks || (block > 0 && id <= blockIds[block - 1]) || offsets[block] !== active) {
      throw new Error('Invalid sparse coverage directory');
    }
    const blockX = id % columns, blockY = Math.floor(id / columns);
    const validWidth = Math.min(BLOCK_SIZE, width - blockX * BLOCK_SIZE);
    const validHeight = Math.min(BLOCK_SIZE, height - blockY * BLOCK_SIZE);
    let blockActive = 0;
    for (let row = 0; row < BLOCK_SIZE; row++) {
      for (let byte = 0; byte < BLOCK_SIZE / 8; byte++) {
        const index = block * MASK_BYTES + row * (BLOCK_SIZE / 8) + byte;
        const out = output[index], support = halo[index];
        const validBits = row < validHeight ? Math.max(0, Math.min(8, validWidth - byte * 8)) : 0;
        const validMask = (1 << validBits) - 1;
        if ((out & support) !== 0 || ((out | support) & ~validMask) !== 0) throw new Error('Invalid sparse coverage masks');
        blockActive += popcount(out | support);
      }
    }
    if (blockActive === 0) throw new Error('Empty sparse coverage block');
    active += blockActive;
    if (active > 0xffffffff || offsets[block + 1] !== active) throw new Error('Invalid sparse coverage offsets');
  }
  return coverage;
}

export function sparseCoverageFromDense(input: {
  width: number; height: number; wrapLongitude: boolean; gridHash: string; output: Uint8Array; halo: Uint8Array;
}): SparseCoverage {
  const { width, height, output, halo } = input;
  const { columns, blocks } = dimensions(width, height);
  if (typeof input.wrapLongitude !== 'boolean' || typeof input.gridHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.gridHash)) {
    throw new Error('Invalid sparse coverage metadata');
  }
  const cells = width * height, bytes = Math.ceil(cells / 8);
  if (!(output instanceof Uint8Array) || !(halo instanceof Uint8Array) || output.length !== bytes || halo.length !== bytes) {
    throw new Error('Invalid dense coverage masks');
  }
  for (let i = 0; i < bytes; i++) {
    const valid = i === bytes - 1 && cells % 8 ? (1 << (cells % 8)) - 1 : 255;
    if ((output[i] & halo[i]) !== 0 || ((output[i] | halo[i]) & ~valid) !== 0) throw new Error('Invalid dense coverage masks');
  }
  const ids: number[] = [];
  for (let id = 0; id < blocks; id++) {
    const x0 = (id % columns) * BLOCK_SIZE, y0 = Math.floor(id / columns) * BLOCK_SIZE;
    let found = false;
    for (let y = y0; y < Math.min(y0 + BLOCK_SIZE, height) && !found; y++) {
      for (let x = x0; x < Math.min(x0 + BLOCK_SIZE, width); x++) {
        const cell = y * width + x, byte = Math.floor(cell / 8);
        if (((output[byte] | halo[byte]) & (1 << (cell % 8))) !== 0) { found = true; break; }
      }
    }
    if (found) {
      ids.push(id);
      if (HEADER_BYTES + ids.length * BLOCK_BYTES > MAX_BYTES) throw new RangeError('Sparse coverage exceeds byte limit');
    }
  }
  const blockIds = Uint32Array.from(ids), offsets = new Uint32Array(ids.length + 1);
  const sparseOutput = new Uint8Array(ids.length * MASK_BYTES), sparseHalo = new Uint8Array(ids.length * MASK_BYTES);
  let active = 0;
  for (let block = 0; block < ids.length; block++) {
    const x0 = (ids[block] % columns) * BLOCK_SIZE, y0 = Math.floor(ids[block] / columns) * BLOCK_SIZE;
    for (let y = y0; y < Math.min(y0 + BLOCK_SIZE, height); y++) {
      for (let x = x0; x < Math.min(x0 + BLOCK_SIZE, width); x++) {
        const cell = y * width + x, denseByte = Math.floor(cell / 8), denseBit = 1 << (cell % 8);
        const local = (y - y0) * BLOCK_SIZE + x - x0, sparseByte = block * MASK_BYTES + Math.floor(local / 8), sparseBit = 1 << (local % 8);
        if (output[denseByte] & denseBit) { sparseOutput[sparseByte] |= sparseBit; active++; }
        if (halo[denseByte] & denseBit) { sparseHalo[sparseByte] |= sparseBit; active++; }
      }
    }
    offsets[block + 1] = active;
  }
  return createSparseCoverage({ width, height, wrapLongitude: input.wrapLongitude, gridHash: input.gridHash, blockIds, offsets, output: sparseOutput, halo: sparseHalo });
}

export function sparseCoverageLookup(coverage: SparseCoverage, x: number, y: number): { output: boolean; halo: boolean; offset: number } | null {
  const { width, height, wrapLongitude, blockIds, offsets, output, halo } = coverage;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || y < 0 || y >= height) return null;
  if (wrapLongitude) x = ((x % width) + width) % width;
  else if (x < 0 || x >= width) return null;
  const columns = Math.ceil(width / BLOCK_SIZE), id = Math.floor(y / BLOCK_SIZE) * columns + Math.floor(x / BLOCK_SIZE);
  let lo = 0, hi = blockIds.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (blockIds[mid] < id) lo = mid + 1; else hi = mid;
  }
  if (lo === blockIds.length || blockIds[lo] !== id) return null;
  const local = (y % BLOCK_SIZE) * BLOCK_SIZE + x % BLOCK_SIZE, byte = Math.floor(local / 8), bit = 1 << (local % 8), start = lo * MASK_BYTES;
  const out = (output[start + byte] & bit) !== 0, support = (halo[start + byte] & bit) !== 0;
  if (!out && !support) return null;
  let offset = offsets[lo];
  for (let i = 0; i < byte; i++) offset += popcount(output[start + i] | halo[start + i]);
  offset += popcount((output[start + byte] | halo[start + byte]) & (bit - 1));
  return { output: out, halo: support, offset };
}

export function encodeSparseCoverage(coverage: SparseCoverage): Uint8Array {
  createSparseCoverage(coverage);
  const { width, height, wrapLongitude, gridHash, blockIds, offsets, output, halo } = coverage;
  const count = blockIds.length, bytes = new Uint8Array(HEADER_BYTES + count * BLOCK_BYTES), view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, width, true);
  view.setUint32(12, height, true);
  view.setUint32(16, wrapLongitude ? 1 : 0, true);
  view.setUint32(20, count, true);
  view.setUint32(24, offsets[count], true);
  for (let i = 0; i < 32; i++) bytes[28 + i] = Number.parseInt(gridHash.slice(i * 2, i * 2 + 2), 16);
  for (let i = 0; i < count; i++) {
    view.setUint32(HEADER_BYTES + i * 8, blockIds[i], true);
    view.setUint32(HEADER_BYTES + i * 8 + 4, offsets[i], true);
  }
  bytes.set(output, HEADER_BYTES + count * 8);
  bytes.set(halo, HEADER_BYTES + count * 8 + output.length);
  return bytes;
}

export function decodeSparseCoverage(bytes: Uint8Array, expectedGridHash?: string): SparseCoverage {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_BYTES || bytes.length > MAX_BYTES) throw new Error('Invalid sparse coverage bytes');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== 1) throw new Error('Invalid sparse coverage format');
  const width = view.getUint32(8, true), height = view.getUint32(12, true), flags = view.getUint32(16, true);
  const count = view.getUint32(20, true), active = view.getUint32(24, true);
  const { blocks } = dimensions(width, height);
  if (flags > 1 || count > blocks || HEADER_BYTES + count * BLOCK_BYTES !== bytes.length) throw new Error('Invalid sparse coverage directory length');
  const gridHash = Array.from(bytes.subarray(28, 60), value => value.toString(16).padStart(2, '0')).join('');
  if (expectedGridHash !== undefined && gridHash !== expectedGridHash) throw new Error('Sparse coverage grid identity mismatch');
  const blockIds = new Uint32Array(count), offsets = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) {
    blockIds[i] = view.getUint32(HEADER_BYTES + i * 8, true);
    offsets[i] = view.getUint32(HEADER_BYTES + i * 8 + 4, true);
  }
  offsets[count] = active;
  const start = HEADER_BYTES + count * 8;
  return createSparseCoverage({ width, height, wrapLongitude: flags === 1, gridHash, blockIds, offsets,
    output: bytes.slice(start, start + count * MASK_BYTES), halo: bytes.slice(start + count * MASK_BYTES) });
}
