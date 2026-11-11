import { INDEXED_GRID, INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { describeCoverage, describeSparseCoverage, loadCoverage, readCoverage, readSparseCoverage, writeCoverage, writeSparseCoverage } from './coverage.js';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { canonicalGridJson, coverageIndices, sparseCoverageFromDense, type CoverageMask } from '@av/contracts';
import { resolveProductFrameHours } from '@av/forecast';
import { validateBuild } from './validate.js';

import { fixtureManifestV5 } from '../../../tests/forecast-fixture.js';

describe('coverage integrity', () => {
  it('uses identical bundled/published descriptors and rejects changed persisted bitsets', async () => {
    const mask = await loadCoverage(INDEXED_PRODUCT), description = describeCoverage(mask, INDEXED_PRODUCT);
    const bundled = await readFile(new URL('../../../packages/contracts/coverage/manifest.json', import.meta.url));
    expect(bundled.equals(description.bytes)).toBe(true);
    const source = JSON.parse(await readFile(new URL('../../../packages/contracts/coverage/source.json', import.meta.url), 'utf8'));
    const root = await mkdtemp(join(tmpdir(), 'av-coverage-format-'));
    try {
      const hash = await writeCoverage(root, mask, INDEXED_PRODUCT);
      expect(hash).toBe(description.hash);
      for (const name of ['output', 'halo', 'tiles'] as const) {
        expect(description.descriptor.files[name].sha256).toBe(source[name].sha256);
        const path = join(root, 'coverage', hash, `${name}.bin`), changed = Uint8Array.from(mask[name]);
        changed[0] ^= 1;
        await writeFile(path, changed);
        await expect(readCoverage(root, hash)).rejects.toThrow(`Coverage ${name} bitset hash mismatch`);
        await writeFile(path, mask[name]);
      }
      expect(await readCoverage(root, hash)).toEqual(mask);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects incompatible grids, domains and targets above the coverage ceiling', async () => {
    const mask = await loadCoverage(INDEXED_PRODUCT);
    for (const product of [
      { ...INDEXED_PRODUCT, grid: { ...INDEXED_GRID, width: 4 } },
      { ...INDEXED_PRODUCT, bounds: [-180, -50, 180, 65] as const },
      { ...INDEXED_PRODUCT, maxNativeZoom: mask.maxZoom + 1 }
    ]) await expect(loadCoverage(product)).rejects.toThrow('trusted product');
  });
  it('reuses immutable coverage and its identity across rendered zoom targets', async () => {
    const original = await loadCoverage(INDEXED_PRODUCT), hash = describeCoverage(original, INDEXED_PRODUCT).hash;
    for (const maxNativeZoom of [0, original.maxZoom]) {
      const configured = { ...INDEXED_PRODUCT, maxNativeZoom }, mask = await loadCoverage(configured);
      expect(mask).toEqual(original);
      expect(describeCoverage(mask, configured).hash).toBe(hash);
    }
  });
  it('rejects a modified output, halo or tile bitset during v5 validation', async () => {
    const product = getProduct('gfs')!, original = await loadCoverage(product);
    const manifest = fixtureManifestV5({ layers: [...product.layers] });
    for (const name of ['output', 'halo', 'tiles'] as const) {
      const changed: CoverageMask = { ...original, [name]: Uint8Array.from(original[name]) };
      changed[name][0] ^= 1;
      await expect(validateBuild('.', manifest, changed)).rejects.toThrow('Native coverage identity mismatch');
    }
  });
});

it('retains RRFS night hours throughout its native point horizon', async () => {
  const product = getProduct('rrfs');
  if (!product) throw new Error('RRFS product');
  const mask = await loadCoverage(product);
  expect(resolveProductFrameHours(product, mask, '2026-12-21T00:00:00Z', { outputIndices: coverageIndices(mask).output }))
    .toEqual(product.frameHours);
});

it('writes and verifies sparse coverage artifacts without changing dense descriptors', async () => {
  const grid = { ...INDEXED_GRID, width: 3, height: 3, wrapLongitude: false }, gridHash = createHash('sha256').update(canonicalGridJson(grid)).digest('hex');
  const coverage = sparseCoverageFromDense({ width: 3, height: 3, wrapLongitude: false, gridHash, output: Uint8Array.of(0x10, 0), halo: Uint8Array.of(0xef, 1) });
  const mask = { grid, coverage, tiles: Uint8Array.of(1), maxZoom: 0 };
  const root = await mkdtemp(join(tmpdir(), 'av-sparse-coverage-'));
  try {
    const description = describeSparseCoverage(mask, INDEXED_PRODUCT), hash = await writeSparseCoverage(root, mask, INDEXED_PRODUCT);
    expect(hash).toBe(description.hash);
    expect(await writeSparseCoverage(root, mask, INDEXED_PRODUCT)).toBe(hash);
    expect(await readSparseCoverage(root, hash)).toEqual({ descriptor: description.descriptor, bytes: description.bytes, mask: { ...mask, bounds: INDEXED_PRODUCT.bounds } });
    for (const name of ['sparse', 'tiles'] as const) {
      const path = join(root, 'coverage', hash, `${name}.bin`), data = await readFile(path), changed = Buffer.from(data);
      changed[0] ^= 1; await writeFile(path, changed);
      await expect(readSparseCoverage(root, hash)).rejects.toThrow(`Coverage ${name} hash mismatch`);
      await writeFile(path, data);
    }
    await expect(writeSparseCoverage(root, { ...mask, coverage: { ...coverage, gridHash: '0'.repeat(64) } }, INDEXED_PRODUCT)).rejects.toThrow('grid mismatch');
  } finally { await rm(root, { recursive: true, force: true }); }
});
