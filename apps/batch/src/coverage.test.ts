import { describe, expect, it } from 'vitest';
import { GFS_GRID, type CoverageMask } from '@av/contracts';
import { loadCoverage, validateBuild, verifyCoverage } from './validate.js';

function manifest(hash: string) {
  const timestamp = '2026-10-30T00:00:00.000Z', digest = '0'.repeat(64);
  return { version: 1, model: 'gfs', buildId: 'test', cycle: timestamp, createdAt: timestamp, expiresAt: '2026-10-31T00:00:00.000Z', method: { id: 'test', hash: digest }, coverage: { id: 'soaring-land-v1', hash, maskKey: 'mask', maxZoom: 5 }, grid: GFS_GRID, frames: [{ id: 'f003', validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp }], layers: ['precip-rate'], artifacts: [{ layer: 'precip-rate', frame: 'f003', tilesKey: 'tile', samplesKey: 'samples', tilesSha256: digest, samplesSha256: digest }], source: {}, tool: {}, palettes: ['rain'], metrics: {} };
}

describe('coverage integrity', () => {
  it('rejects a modified output, halo or tile bitset during validation', async () => {
    const original = await loadCoverage(), hash = await verifyCoverage(original);
    for (const name of ['output', 'halo', 'tiles'] as const) {
      const changed: CoverageMask = { ...original, [name]: Uint8Array.from(original[name]) };
      changed[name][0] ^= 1;
      await expect(verifyCoverage(changed)).rejects.toThrow(`Coverage ${name} bitset hash mismatch`);
      await expect(validateBuild('.', manifest(hash), changed)).rejects.toThrow(`Coverage ${name} bitset hash mismatch`);
    }
  });
  it('rejects a stale manifest hash even when the coverage id matches', async () => {
    const mask = await loadCoverage(), actual = await verifyCoverage(mask);
    const stale = '11c546afed8452c496c6923edac5207e314064a6dd252791c09d0ee7e888cf6f';
    expect(actual).not.toBe(stale);
    await expect(validateBuild('.', manifest(stale), mask)).rejects.toThrow('Coverage identity mismatch');
  });
});
