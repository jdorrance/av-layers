import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readLocalFile } from './local-file.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { coverageDescriptorSchema, coveragePrefix, GFS_PRODUCT, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_COVERAGE_BITSET_BYTES, parseBoundedJson, sameGrid, SAMPLE_BLOCK_SIZE, type CoverageDescriptor, type CoverageMask, type ProductDefinition } from '@av/contracts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const names = ['output', 'halo', 'tiles'] as const;

export function describeCoverage(mask: CoverageMask, product: ProductDefinition): { descriptor: CoverageDescriptor; bytes: Uint8Array; hash: string } {
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
export async function writeCoverage(root: string, mask: CoverageMask, product: ProductDefinition): Promise<string> {
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
export async function loadCoverage(product: ProductDefinition = GFS_PRODUCT): Promise<CoverageMask> {
  const dir = fileURLToPath(new URL('../../../packages/contracts/coverage', import.meta.url));
  const result = await readCoverageDirectory(dir);
  if (!sameGrid(result.mask.grid, product.grid) || result.mask.maxZoom !== product.maxNativeZoom || JSON.stringify(result.mask.bounds) !== JSON.stringify(product.bounds) || JSON.stringify(describeCoverage(result.mask, product).descriptor) !== JSON.stringify(result.descriptor)) throw new Error('Coverage does not match the trusted product');
  return result.mask;
}

export async function readCoverage(root: string, coverageHash: string): Promise<CoverageMask> {
  return (await readCoverageDirectory(join(root, coveragePrefix(coverageHash)), coverageHash)).mask;
}
