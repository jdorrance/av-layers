import { expect, it, vi } from 'vitest';
import { GFS_GRID } from '@av/contracts';

vi.mock('../../../packages/contracts/coverage/output.bin', () => ({ default: Uint8Array.of(1).buffer }));
vi.mock('../../../packages/contracts/coverage/halo.bin', () => ({ default: Uint8Array.of(0).buffer }));
vi.mock('../../../packages/contracts/coverage/tiles.bin', () => ({ default: Uint8Array.of(0).buffer }));
vi.mock('../../../packages/contracts/coverage/manifest.json', () => ({ default: new TextEncoder().encode(JSON.stringify({ id: 'soaring-land-v1', output: { bytes: 1, sha256: '0'.repeat(64) }, halo: { bytes: 1, sha256: '0'.repeat(64) }, tiles: { bytes: 1, sha256: '0'.repeat(64) } })).buffer }));

import worker from '../src/index';

it('fails closed if bundled mask bytes do not match the coverage witness', async () => {
  const hash = 'a'.repeat(64), cycle = '2026-10-29T18:00:00Z', expiresAt = '2026-10-31T00:00:00Z';
  const retained = { buildId: 'old', manifestKey: 'builds/gfs/old/manifest.json', cycle, expiresAt };
  const pointer = { version: 1, model: 'gfs', latestBuildId: 'old', retained: [retained] };
  const frame = { id: 'f003', validTime: cycle, intervalStart: cycle, intervalEnd: cycle };
  const manifest = { version: 1, model: 'gfs', buildId: 'old', cycle, createdAt: cycle, expiresAt, method: { id: 'method', hash }, coverage: { id: 'soaring-land-v1', hash, maskKey: 'mask', maxZoom: 5 }, grid: GFS_GRID, frames: [frame], layers: ['precip-rate'], artifacts: [{ layer: 'precip-rate', frame: 'f003', tilesKey: 'builds/gfs/old/precip-rate/f003.pmtiles', samplesKey: 'builds/gfs/old/samples/precip-rate/f003.bin', tilesSha256: hash, samplesSha256: hash }], source: {}, tool: {}, palettes: ['rain'], metrics: {} };
  const cache = { match: vi.fn(), put: vi.fn() };
  vi.stubGlobal('caches', { default: cache });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.parse('2026-10-30T00:00:00Z'));
  const get = vi.fn(async (key: string) => ({ async json() { return key.startsWith('catalog/') ? pointer : manifest; } }));
  const env = { BUCKET: { get } as unknown as R2Bucket, SAMPLE_RATE_LIMITER: { async limit() { return { success: true }; } } };
  try {
    for (const path of ['/tiles/gfs/old/precip-rate/f003/1/0/0.png', '/v1/models/gfs/runs/old/sample?lat=0&lon=0']) {
      const response = await worker.fetch(new Request(`https://api.example${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), env, { waitUntil() {} });
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    expect(cache.match).not.toHaveBeenCalled();
    expect(get.mock.calls.every(([key]) => !key.includes('/samples/'))).toBe(true);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
