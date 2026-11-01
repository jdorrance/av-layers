import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readLocalFile } from './local-file.js';
import { join } from 'node:path';
import { coverageDescriptorSchema, coveragePrefix, SAMPLE_BLOCK_SIZE, type CoverageDescriptor, type CoverageMask, type ProductDefinition } from '@av/contracts';

const hash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const names = ['output', 'halo', 'tiles'] as const;

export function describeCoverage(mask: CoverageMask, product: ProductDefinition): { descriptor: CoverageDescriptor; bytes: Uint8Array; hash: string } {
  const descriptor = coverageDescriptorSchema.parse({
    version: 1, id: product.coverageId, grid: mask.grid, bounds: mask.bounds ?? product.bounds,
    policy: product.coverageDescription, maxZoom: mask.maxZoom, supportHaloCells: 1,
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

export async function readCoverage(root: string, coverageHash: string): Promise<CoverageMask> {
  const dir = join(root, coveragePrefix(coverageHash)), bytes = await readLocalFile(join(dir, 'manifest.json'), 128 * 1024);
  if (hash(bytes) !== coverageHash) throw new Error('Coverage descriptor hash mismatch');
  const descriptor = coverageDescriptorSchema.parse(JSON.parse(bytes.toString('utf8')));
  const files = await Promise.all(names.map(async name => {
    const expected = descriptor.files[name], data = await readLocalFile(join(dir, `${name}.bin`), 512 * 1024, expected.bytes);
    if (data.byteLength !== expected.bytes || hash(data) !== expected.sha256) throw new Error(`Coverage ${name} bitset hash mismatch`);
    return data;
  }));
  return { grid: descriptor.grid, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, output: files[0], halo: files[1], tiles: files[2] };
}
