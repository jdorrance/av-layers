import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readLocalFile } from './local-file.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCoverageBinding, assertSparseCoverageHalo, canonicalGridJson, coverageDescriptorSchema, sparseCoverageDescriptorSchema, coveragePrefix, decodeSparseCoverage, encodeSparseCoverage, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_COVERAGE_BITSET_BYTES, MAX_SPARSE_COVERAGE_BYTES, parseBoundedJson, sameGrid, SAMPLE_BLOCK_SIZE, type CoverageDescriptor, type CoverageMask, type ProductDefinition, type SparseCoverageDescriptor, type SparseCoverageMask } from '@av/contracts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const names = ['output', 'halo', 'tiles'] as const;

type CoverageDefinition = Pick<ProductDefinition, 'coverageId' | 'coverageDescription' | 'bounds' | 'supportHaloCells'>;

export function describeCoverage(mask: CoverageMask, product: CoverageDefinition): { descriptor: CoverageDescriptor; bytes: Uint8Array; hash: string } {
  const descriptor = coverageDescriptorSchema.parse({
    version: 1, id: product.coverageId, grid: mask.grid, bounds: mask.bounds ?? product.bounds,
    policy: product.coverageDescription, maxZoom: mask.maxZoom, supportHaloCells: product.supportHaloCells,
    sampleLayout: { format: 'cell-major-blocks-v1', blockSize: SAMPLE_BLOCK_SIZE },
    files: Object.fromEntries(names.map(name => [name, { bytes: mask[name].byteLength, sha256: hash(mask[name]) }]))
  });
  const bytes = Buffer.from(JSON.stringify(descriptor));
  return { descriptor, bytes, hash: hash(bytes) };
}

/** Write once or prove equality. Repeated builds reuse the same immutable coverage object. */
export async function writeCoverage(root: string, mask: CoverageMask, product: CoverageDefinition): Promise<string> {
  const description = describeCoverage(mask, product), dir = join(root, coveragePrefix(description.hash));
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of [...names.map(name => [`${name}.bin`, mask[name]] as const), ['manifest.json', description.bytes] as const]) {
    const path = join(dir, name);
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readLocalFile(path, bytes.byteLength, bytes.byteLength)).equals(bytes)) throw error;
    }
  }
  return description.hash;
}

async function readCoverageDirectory(dir: string, expectedHash?: string): Promise<{ mask: CoverageMask; descriptor: CoverageDescriptor }> {
  const bytes = await readLocalFile(join(dir, 'manifest.json'), MAX_COVERAGE_DESCRIPTOR_BYTES), descriptorHash = hash(bytes);
  if (expectedHash && descriptorHash !== expectedHash) throw new Error('Coverage descriptor hash mismatch');
  const descriptor = coverageDescriptorSchema.parse(parseBoundedJson(bytes));
  const files = await Promise.all(names.map(async name => {
    const expected = descriptor.files[name], data = await readLocalFile(join(dir, `${name}.bin`), MAX_COVERAGE_BITSET_BYTES, expected.bytes);
    if (hash(data) !== expected.sha256) throw new Error(`Coverage ${name} bitset hash mismatch`);
    return data;
  }));
  return { descriptor, mask: { grid: descriptor.grid, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, output: files[0], halo: files[1], tiles: files[2] } };
}

/** Bundled and published masks use the same descriptor and hash validation. */
export async function loadCoverage(product: ProductDefinition): Promise<CoverageMask> {
  const dir = fileURLToPath(new URL(`../../../packages/contracts/${product.coverageDir}`, import.meta.url));
  let result: { mask: CoverageMask; descriptor: CoverageDescriptor };
  try {
    result = await readCoverageDirectory(dir);
  } catch {
    throw new Error('Coverage does not match the trusted product');
  }
  if (!sameGrid(result.mask.grid, product.grid) || result.mask.maxZoom < product.maxNativeZoom || JSON.stringify(result.mask.bounds) !== JSON.stringify(product.bounds) || JSON.stringify(describeCoverage(result.mask, product).descriptor) !== JSON.stringify(result.descriptor)) throw new Error('Coverage does not match the trusted product');
  return result.mask;
}

export async function readCoverage(root: string, coverageHash: string): Promise<CoverageMask> {
  return (await readCoverageDirectory(join(root, coveragePrefix(coverageHash)), coverageHash)).mask;
}

export async function readGridCoverage(root: string, grid: Parameters<typeof assertCoverageBinding>[1]): Promise<CoverageMask> {
  const result = await readCoverageDirectory(join(root, coveragePrefix(grid.coverage.hash)), grid.coverage.hash);
  assertCoverageBinding(result.descriptor, grid);
  return result.mask;
}

export function describeSparseCoverage(mask: SparseCoverageMask, product: CoverageDefinition): { descriptor: SparseCoverageDescriptor; bytes: Uint8Array; sparseBytes: Uint8Array; hash: string } {
  const gridHash = hash(Buffer.from(canonicalGridJson(mask.grid)));
  if (mask.coverage.gridHash !== gridHash || mask.coverage.width !== mask.grid.width || mask.coverage.height !== mask.grid.height || mask.coverage.wrapLongitude !== mask.grid.wrapLongitude || mask.coverage.blockIds.length === 0) throw new Error('Sparse coverage grid mismatch');
  assertSparseCoverageHalo(mask.coverage);
  const sparseBytes = encodeSparseCoverage(mask.coverage);
  const descriptor = sparseCoverageDescriptorSchema.parse({
    version: 2, id: product.coverageId, grid: mask.grid, gridHash, bounds: mask.bounds ?? product.bounds,
    policy: product.coverageDescription, maxZoom: mask.maxZoom, supportHaloCells: 1,
    sampleLayout: { format: 'cell-major-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE },
    files: { sparse: { bytes: sparseBytes.length, sha256: hash(sparseBytes) }, tiles: { bytes: mask.tiles.length, sha256: hash(mask.tiles) } }
  });
  const bytes = Buffer.from(JSON.stringify(descriptor));
  if (bytes.length > MAX_COVERAGE_DESCRIPTOR_BYTES) throw new Error('Coverage descriptor exceeds byte limit');
  return { descriptor, bytes, sparseBytes, hash: hash(bytes) };
}

export async function writeSparseCoverage(root: string, mask: SparseCoverageMask, product: CoverageDefinition): Promise<string> {
  const description = describeSparseCoverage(mask, product), dir = join(root, coveragePrefix(description.hash));
  await mkdir(dir, { recursive: true });
  for (const [name, bytes] of [['sparse.bin', description.sparseBytes], ['tiles.bin', mask.tiles], ['manifest.json', description.bytes]] as const) {
    const path = join(dir, name);
    try { await writeFile(path, bytes, { flag: 'wx' }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !Buffer.from(await readLocalFile(path, bytes.byteLength, bytes.byteLength)).equals(bytes)) throw error;
    }
  }
  return description.hash;
}

export async function readSparseCoverage(root: string, coverageHash: string): Promise<{ descriptor: SparseCoverageDescriptor; mask: SparseCoverageMask; bytes: Uint8Array }> {
  const dir = join(root, coveragePrefix(coverageHash)), bytes = await readLocalFile(join(dir, 'manifest.json'), MAX_COVERAGE_DESCRIPTOR_BYTES);
  if (hash(bytes) !== coverageHash) throw new Error('Coverage descriptor hash mismatch');
  const descriptor = sparseCoverageDescriptorSchema.parse(parseBoundedJson(bytes));
  if (hash(Buffer.from(canonicalGridJson(descriptor.grid))) !== descriptor.gridHash) throw new Error('Sparse coverage grid hash mismatch');
  const [sparse, tiles] = await Promise.all((['sparse', 'tiles'] as const).map(async name => {
    const file = descriptor.files[name], data = await readLocalFile(join(dir, `${name}.bin`), name === 'sparse' ? MAX_SPARSE_COVERAGE_BYTES : MAX_COVERAGE_BITSET_BYTES, file.bytes);
    if (hash(data) !== file.sha256) throw new Error(`Coverage ${name} hash mismatch`);
    return data;
  }));
  const coverage = decodeSparseCoverage(new Uint8Array(sparse.buffer, sparse.byteOffset, sparse.byteLength), descriptor.gridHash);
  if (coverage.width !== descriptor.grid.width || coverage.height !== descriptor.grid.height || coverage.wrapLongitude !== descriptor.grid.wrapLongitude || coverage.blockIds.length === 0) throw new Error('Sparse coverage grid mismatch');
  assertSparseCoverageHalo(coverage);
  return { descriptor, bytes, mask: { grid: descriptor.grid, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, coverage, tiles: Uint8Array.from(tiles) } };
}
