import { describeCoverage, loadCoverage, readCoverage, writeCoverage } from './coverage.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GFS_GRID, GFS_PRODUCT, createProductDescriptors, createRecipeIdentity, type CoverageMask } from '@av/contracts';
import { validateBuild } from './validate.js';

function manifest(hash: string) {
  const timestamp = '2026-10-30T00:00:00.000Z', digest = '0'.repeat(64);
  return { version: 3, descriptors: createProductDescriptors(), recipe: createRecipeIdentity(GFS_PRODUCT, digest), model: 'gfs', buildId: 'test', cycle: timestamp, createdAt: timestamp, expiresAt: '2026-10-31T00:00:00.000Z', method: { id: 'test', hash: digest }, coverage: { id: 'soaring-land-v1', hash, maskKey: `coverage/${hash}/manifest.json`, maxZoom: 7 }, grid: GFS_GRID, frames: [{ id: 'f003', validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp }], layers: ['precip-rate'], artifacts: [{ layer: 'precip-rate', frame: 'f003', tilesKey: 'tile', tilesSha256: digest }], samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 1, channelCount: 1, bytes: 5, key: 'builds/gfs/test/samples.bin', sha256: digest }, source: { provider: 'NOAA', provenanceKey: 'builds/gfs/test/provenance.json', provenanceSha256: digest }, tool: {}, palettes: ['rain'], metrics: {} };
}

describe('coverage integrity', () => {
  it('uses identical bundled/published descriptors and rejects changed persisted bitsets', async () => {
    const mask = await loadCoverage(), description = describeCoverage(mask, GFS_PRODUCT);
    const bundled = await readFile(new URL('../../../packages/contracts/coverage/manifest.json', import.meta.url));
    expect(bundled.equals(description.bytes)).toBe(true);
    const source = JSON.parse(await readFile(new URL('../../../packages/contracts/coverage/source.json', import.meta.url), 'utf8'));
    const root = await mkdtemp(join(tmpdir(), 'av-coverage-format-'));
    try {
      const hash = await writeCoverage(root, mask, GFS_PRODUCT);
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
  it('rejects a product with a different grid, domain or native zoom', async () => {
    for (const product of [
      { ...GFS_PRODUCT, grid: { ...GFS_GRID, width: 4 } },
      { ...GFS_PRODUCT, bounds: [-180, -50, 180, 65] as const },
      { ...GFS_PRODUCT, maxNativeZoom: 6 }
    ]) await expect(loadCoverage(product)).rejects.toThrow('trusted product');
  });
  it('rejects a modified output, halo or tile bitset during validation', async () => {
    const original = await loadCoverage(), hash = describeCoverage(original, GFS_PRODUCT).hash;
    for (const name of ['output', 'halo', 'tiles'] as const) {
      const changed: CoverageMask = { ...original, [name]: Uint8Array.from(original[name]) };
      changed[name][0] ^= 1;
      await expect(validateBuild('.', manifest(hash), changed)).rejects.toThrow('Coverage identity mismatch');
    }
  });
  it('rejects a stale manifest hash even when the coverage id matches', async () => {
    const mask = await loadCoverage(), actual = describeCoverage(mask, GFS_PRODUCT).hash;
    const stale = '11c546afed8452c496c6923edac5207e314064a6dd252791c09d0ee7e888cf6f';
    expect(actual).not.toBe(stale);
    await expect(validateBuild('.', manifest(stale), mask)).rejects.toThrow('Coverage identity mismatch');
  });
});
