import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSparseCoverageHalo, canonicalGridJson, coverageIndices, decodeSparseCoverage,
  encodeSparseCoverage, MAX_COVERAGE_BITSET_BYTES, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_SPARSE_COVERAGE_BYTES,
  parseBoundedJson, planWholeDomainGrid, SAMPLE_BLOCK_SIZE,
  sameGrid, sparseCoverageDescriptorSchema, sparseCoverageFromDense, wholeDomainDonorSupport, type CoverageMask,
  type ProductDefinition, type RegularLatLonGrid, type SparseCoverage, type SparseCoverageDescriptor, type SparseCoverageMask, type WholeDomainGrid
} from '@av/contracts';
import { describeSparseCoverage, writeSparseCoverage } from '../coverage.js';
import { readLocalFile } from '../local-file.js';

const digest = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const packageRoot = fileURLToPath(new URL('../../../../packages/contracts/', import.meta.url));

export function configuredTerrainSubdivision(product: ProductDefinition): number | undefined {
  const k = product.terrainSubdivisionFactor;
  if (k === undefined) return undefined;
  if (!Number.isSafeInteger(k) || k < 1 || k > 64) throw new Error('Product terrain subdivision factor is invalid');
  return k;
}

export function wholeDomainPlan(product: ProductDefinition): WholeDomainGrid | undefined {
  const k = configuredTerrainSubdivision(product);
  return k === undefined ? undefined : planWholeDomainGrid(product.grid as RegularLatLonGrid, k);
}

export async function stageFineCoverage(root: string, fine: { hash: string; bytes: Uint8Array; mask: SparseCoverageMask }): Promise<void> {
  const directory = join(root, 'coverage', fine.hash);
  await mkdir(directory, { recursive: true });
  for (const [name, bytes] of [['manifest.json', fine.bytes], ['sparse.bin', encodeSparseCoverage(fine.mask.coverage)], ['tiles.bin', fine.mask.tiles]] as const) {
    const path = join(directory, name);
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !(await readLocalFile(path, bytes.byteLength + 1, bytes.byteLength)).equals(Buffer.from(bytes))) throw error; }
  }
}

function sparseCoverageFromMask(mask: CoverageMask): SparseCoverage {
  return sparseCoverageFromDense({ width: mask.grid.width, height: mask.grid.height, wrapLongitude: mask.grid.wrapLongitude,
    gridHash: digest(canonicalGridJson(mask.grid)), output: mask.output, halo: mask.halo });
}

export function nativeSparseMask(mask: CoverageMask): SparseCoverageMask {
  return { grid: mask.grid, bounds: mask.bounds, maxZoom: mask.maxZoom, tiles: mask.tiles, coverage: sparseCoverageFromMask(mask) };
}

export async function writeNativeCoverage(root: string, mask: CoverageMask, product: ProductDefinition): Promise<{ mask: SparseCoverageMask; descriptor: SparseCoverageDescriptor; bytes: Uint8Array; hash: string }> {
  const sparse = nativeSparseMask(mask), description = describeSparseCoverage(sparse, product);
  const hash = await writeSparseCoverage(root, sparse, product);
  if (hash !== description.hash) throw new Error('Native sparse coverage hash changed during write');
  return { mask: sparse, descriptor: description.descriptor, bytes: description.bytes, hash };
}

export async function loadBundledFineCoverage(product: ProductDefinition, plan: WholeDomainGrid): Promise<{ mask: SparseCoverageMask; descriptor: SparseCoverageDescriptor; bytes: Uint8Array; hash: string }> {
  const directory = `${packageRoot}${product.coverageDir}/fine`;
  let manifest: Buffer;
  try { manifest = await readLocalFile(`${directory}/manifest.json`, MAX_COVERAGE_DESCRIPTOR_BYTES); }
  catch (error) { throw new Error(`Fine coverage is missing: ${directory}/manifest.json`, { cause: error }); }
  const bytes = new Uint8Array(manifest.buffer, manifest.byteOffset, manifest.byteLength);
  const descriptor = sparseCoverageDescriptorSchema.parse(parseBoundedJson(bytes));
  if (descriptor.gridHash !== digest(canonicalGridJson(plan.fine)) || !sameGrid(descriptor.grid, plan.fine) || descriptor.id !== product.coverageId || JSON.stringify(descriptor.bounds) !== JSON.stringify(product.bounds) || descriptor.maxZoom < product.maxNativeZoom) throw new Error('Fine coverage does not match the configured whole-domain grid');
  const sparseBytes = await readLocalFile(`${directory}/sparse.bin`, MAX_SPARSE_COVERAGE_BYTES, descriptor.files.sparse.bytes);
  if (sparseBytes.byteLength !== descriptor.files.sparse.bytes || digest(sparseBytes) !== descriptor.files.sparse.sha256) throw new Error('Fine sparse coverage integrity mismatch');
  const tiles = await readLocalFile(`${directory}/tiles.bin`, MAX_COVERAGE_BITSET_BYTES, descriptor.files.tiles.bytes);
  if (tiles.byteLength !== descriptor.files.tiles.bytes || digest(tiles) !== descriptor.files.tiles.sha256) throw new Error('Fine tile coverage integrity mismatch');
  const coverage = decodeSparseCoverage(new Uint8Array(sparseBytes.buffer, sparseBytes.byteOffset, sparseBytes.byteLength), descriptor.gridHash);
  if (coverage.width !== plan.fine.width || coverage.height !== plan.fine.height || coverage.wrapLongitude !== plan.fine.wrapLongitude || !coverage.blockIds.length) throw new Error('Fine sparse coverage grid mismatch');
  assertSparseCoverageHalo(coverage);
  return { mask: { grid: plan.fine, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, tiles: new Uint8Array(tiles), coverage }, descriptor, bytes, hash: digest(bytes) };
}

export function* sparseActiveIndices(coverage: SparseCoverage): Generator<number> {
  const size = SAMPLE_BLOCK_SIZE, columns = Math.ceil(coverage.width / size), blockBytes = size * size / 8;
  for (let block = 0; block < coverage.blockIds.length; block++) {
    const id = coverage.blockIds[block]!, x0 = (id % columns) * size, y0 = Math.floor(id / columns) * size;
    for (let local = 0; local < size * size; local++) {
      const byte = block * blockBytes + (local >> 3), bit = 1 << (local & 7);
      if (((coverage.output[byte]! | coverage.halo[byte]!) & bit) === 0) continue;
      const x = x0 + local % size, y = y0 + Math.floor(local / size);
      if (x < coverage.width && y < coverage.height) yield y * coverage.width + x;
    }
  }
}

function setIndices(bits: Uint8Array): number[] {
  const result: number[] = [];
  for (let byte = 0; byte < bits.length; byte++) {
    let value = bits[byte]!;
    while (value) {
      const bit = 31 - Math.clz32(value & -value);
      result.push(byte * 8 + bit);
      value &= value - 1;
    }
  }
  return result;
}

export function acquisitionSupport(plan: WholeDomainGrid, fine: SparseCoverage, native: CoverageMask): { required: Uint8Array; active: Uint32Array } {
  const required = wholeDomainDonorSupport(plan, sparseActiveIndices(fine));
  const nativeActive = coverageIndices(native).active, donors = setIndices(required);
  const active = new Uint32Array(nativeActive.length + donors.length);
  let i = 0, j = 0, length = 0;
  while (i < nativeActive.length || j < donors.length) {
    const a = i < nativeActive.length ? nativeActive[i]! : Number.POSITIVE_INFINITY;
    const b = j < donors.length ? donors[j]! : Number.POSITIVE_INFINITY;
    if (a === b) { active[length++] = a; i++; j++; }
    else if (a < b) { active[length++] = a; i++; }
    else { active[length++] = b; j++; }
  }
  return { required, active: active.subarray(0, length).slice() };
}
