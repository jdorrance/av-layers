import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ForecastProvider } from '../provider.js';
import { runStationReplay } from './station-replay.js';

const { frozenHash } = vi.hoisted(() => ({ frozenHash: 'f996a85895f7738210f68c4416319484bf3958d7554712ef3ea5958bf32fd37d' }));
vi.mock('node:crypto', () => ({
  createHash: () => ({ update() { return this; }, digest: () => frozenHash })
}));
vi.mock('../local-file.js', () => ({
  readLocalFile: async (path: string) => {
    if (path.endsWith('observations.json')) return Buffer.from('[]');
    if (path.endsWith('ogimet-synop.csv')) return Buffer.from('raw');
    if (path.endsWith('receipt.json')) return Buffer.from(JSON.stringify({
      sha256: frozenHash, bytes: 3, start: '2026-10-15T00:00:00.000Z', endExclusive: '2026-10-25T00:00:00.000Z'
    }));
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  }
}));
vi.mock('../identity.js', () => ({
  buildIdentity: async () => ({
    recipe: { sourceRevision: 'a'.repeat(40), sourceDirty: false },
    components: { adapter: 'adapter', science: 'science', contracts: 'contracts', configuration: 'configuration' }
  })
}));
vi.mock('./evaluation-input.js', () => ({
  loadEvaluationInput: async ({ manifestPath }: { manifestPath: string }) => {
    const grid = { kind: 'regular-latlon', width: 1, height: 1, earthRadiusM: 6371229, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: false };
    return {
      manifest: { model: basename(manifestPath), recipe: { sourceDirty: false }, patches: [{ coverage: { hash: 'coverage' } }] },
      sourceMask: { grid, output: Uint8Array.of(1), halo: Uint8Array.of(0) },
      targetMask: { grid: { ...grid, width: 325, height: 339 } },
      terrain: { descriptor: { dataId: 'terrain' }, elevationM: Float32Array.of(0), valid: Uint8Array.of(1) },
      patch: { id: 'zone-001' }
    };
  },
  normalizeSourceEvidence: (value: unknown) => value
}));

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

it.each([{ peaks: [] }, { peaks: [100, 900, 200] }])('retains the maximum native RSS across serial sessions $peaks', async ({ peaks }) => {
  const out = await mkdtemp(join(tmpdir(), 'av-station-rss-')); roots.push(out);
  const usage = process.resourceUsage();
  vi.spyOn(process, 'resourceUsage').mockReturnValue({ ...usage, maxRSS: 256 * 1024 });
  let opened = 0, closed = 0;
  const provider: ForecastProvider = {
    id: 'fake', provider: 'test', maxLevels: 1,
    async open({ cycle }) {
      const peak = peaks[opened++];
      let nativePeakRssBytes: number | undefined;
      return {
        cycle: cycle!, stats: {},
        get nativePeakRssBytes() { return nativePeakRssBytes; },
        async acquire() {
          nativePeakRssBytes = peak;
          throw new Error('Injected cache miss after native decode');
        },
        async close() { nativePeakRssBytes = 0; closed++; }
      };
    }
  };
  const result = await runStationReplay({
    observations: join(out, 'observations.json'), out: join(out, 'report.json'),
    controls: { 'icon-eu': { manifestPath: '/icon-eu' }, gfs: { manifestPath: '/gfs' } },
    providerFactory: () => provider
  });
  expect(opened).toBe(20);
  expect(closed).toBe(opened);
  expect(result.report.totals.failedFrames).toBe(80);
  const expectedNative = Math.max(0, ...peaks);
  expect(result.report.runtime).toMatchObject({
    maxRssBytes: 256 * 1024 * 1024,
    nativePeakRssBytes: expectedNative,
    combinedPeakRssUpperBoundBytes: 256 * 1024 * 1024 + expectedNative,
    rssScope: 'process-observed; not a full-build memory bound'
  });
  expect(JSON.parse(await readFile(result.path, 'utf8')).runtime).toEqual(result.report.runtime);
});
