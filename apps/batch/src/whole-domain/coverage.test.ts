import { INDEXED_GRID, INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MAX_COVERAGE_BITSET_BYTES, MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_SPARSE_COVERAGE_BYTES, canonicalGridJson, encodeSparseCoverage, sparseCoverageFromDense, type SparseCoverageMask } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import { loadBundledFineCoverage, stageFineCoverage, wholeDomainPlan } from './coverage.js';

vi.mock('../local-file.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../local-file.js')>();
  return { ...actual, readLocalFile: vi.fn(actual.readLocalFile) };
});

const read = vi.mocked(readLocalFile);

function fineCoverage(): { hash: string; bytes: Buffer; mask: SparseCoverageMask } {
  const grid = { ...INDEXED_GRID, width: 3, height: 3, wrapLongitude: false };
  const gridHash = createHash('sha256').update(canonicalGridJson(grid)).digest('hex');
  const coverage = sparseCoverageFromDense({ width: 3, height: 3, wrapLongitude: false, gridHash, output: Uint8Array.of(0x10, 0), halo: Uint8Array.of(0xef, 1) });
  return { hash: 'a'.repeat(64), bytes: Buffer.from('{}'), mask: { grid, coverage, tiles: Uint8Array.of(1), maxZoom: 0 } };
}

describe('bounded fine coverage reads', () => {
  it('rejects oversize and truncated staged artifacts before allocating their bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-fine-coverage-')), fine = fineCoverage();
    const directory = join(root, 'coverage', fine.hash);
    const lengths = { 'manifest.json': fine.bytes.byteLength, 'sparse.bin': encodeSparseCoverage(fine.mask.coverage).byteLength, 'tiles.bin': fine.mask.tiles.byteLength };
    try {
      await stageFineCoverage(root, fine);
      for (const [name, length] of Object.entries(lengths)) {
        const path = join(directory, name), original = await readFile(path);
        await truncate(path, length + 1);
        await expect(stageFineCoverage(root, fine)).rejects.toThrow('byte budget');
        await truncate(path, length - 1);
        await expect(stageFineCoverage(root, fine)).rejects.toThrow('byte budget');
        await writeFile(path, original);
      }
      await truncate(join(directory, 'sparse.bin'), MAX_SPARSE_COVERAGE_BYTES + 1);
      await expect(stageFineCoverage(root, fine)).rejects.toThrow('byte budget');
      await writeFile(join(directory, 'sparse.bin'), encodeSparseCoverage(fine.mask.coverage));
      await expect(stageFineCoverage(root, fine)).resolves.toBeUndefined();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('bounds bundled manifest, sparse and tile reads by descriptor and schema budgets', async () => {
    read.mockClear();
    const product = INDEXED_PRODUCT, plan = wholeDomainPlan(product)!;
    const fine = await loadBundledFineCoverage(product, plan);
    expect(read.mock.calls[0]).toEqual([expect.stringMatching(/coverage\/fine\/manifest\.json$/), MAX_COVERAGE_DESCRIPTOR_BYTES]);
    expect(read.mock.calls[1]).toEqual([expect.stringMatching(/coverage\/fine\/sparse\.bin$/), MAX_SPARSE_COVERAGE_BYTES, fine.descriptor.files.sparse.bytes]);
    expect(read.mock.calls[2]).toEqual([expect.stringMatching(/coverage\/fine\/tiles\.bin$/), MAX_COVERAGE_BITSET_BYTES, fine.descriptor.files.tiles.bytes]);
  });
});
