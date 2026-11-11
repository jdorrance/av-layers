import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { frameProvenanceSchema, multiPointSampleResponseSchema, profileResponseSchema, sampleResponseV5Schema } from '@av/contracts';
import { offlinePreviewFixture } from './fixtures/offline-preview.js';
import { openLocalPreviewStore, seedLocalBuild } from './sample-preview.js';
import { probeApi } from './smoke-api.js';

it('persists a v5 build across local Worker sessions and serves its pinned artifacts', async () => {
  const fixture = await offlinePreviewFixture();
  const local = await fixture.copy();
  try {
    const initial = await seedLocalBuild(local);
    expect(await seedLocalBuild(local)).toMatchObject({ uploadedObjects: 1, reusedObjects: initial.uploadedObjects - 1 });
    const reopened = await openLocalPreviewStore(local.persistTo);
    try {
      const shard = local.native.samples.shards[0];
      expect((await reopened.head(shard.key))?.size).toBe(shard.bytes);
    } finally { await reopened.dispose(); }

    const { unstable_dev } = await import('wrangler');
    const worker = await unstable_dev(fileURLToPath(new URL('../apps/api/test/fixture-worker.ts', import.meta.url)), {
      config: fileURLToPath(new URL('../apps/api/wrangler.json', import.meta.url)),
      local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: true, persistTo: local.persistTo,
      vars: { AV_LOCAL_DEVELOPMENT: 'true' }, envFiles: [], logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false }
    });
    try {
      const origin = `http://${worker.address}:${worker.port}`, { model, buildId } = local.manifest;
      const pinned = `/v1/models/${model}/runs/${buildId}`;
      const read = async (path: string) => {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
        expect(response.status, response.ok ? path : await response.clone().text()).toBe(200);
        return response;
      };
      expect(await (await read('/v1/catalog')).json()).toMatchObject({ models: [expect.objectContaining({ model })] });
      expect(await (await read(`/v1/models/${model}/latest?expand=manifest`)).json()).toMatchObject({ manifest: { buildId, version: 5 } });
      const sample = sampleResponseV5Schema.parse(await (await read(`${pinned}/sample?lat=40&lon=-100&frame=all&layers=usable-lift-agl,precip-rate`)).json());
      expect(sample.frames[0].layers['precip-rate']).toMatchObject({ value: 2.75, status: 'valid', surfaceId: 'native' });
      expect(sample.frames[0].layers['usable-lift-agl']).toMatchObject({ surfaceId: 'fine' });
      const samples = multiPointSampleResponseSchema.parse(await (await read(`${pinned}/samples?points=40,-100;40,-100&layers=precip-rate`)).json());
      expect(samples.points.map(point => point.sample.frames[0].layers['precip-rate'].value)).toEqual([2.75, 2.75]);
      const profile = profileResponseSchema.parse(await (await read(`${pinned}/profile?lat=40&lon=-100&frame=f001`)).json());
      expect(profile.frames[0].profile).toMatchObject({ status: 'valid', levels: [expect.any(Object), expect.any(Object), expect.any(Object)] });
      expect(frameProvenanceSchema.parse(await (await read(`${pinned}/provenance?frame=f001`)).json()).hour).toBe(1);
      const tile = await read(`/tiles/${model}/${buildId}/precip-rate/f001/0/0/0.webp`);
      expect(tile.headers.get('content-type')).toBe('image/webp');
      expect(Buffer.from(await tile.arrayBuffer()).subarray(8, 12).toString()).toBe('WEBP');
      const observeProbe = vi.fn();
      await expect(probeApi({ baseUrl: origin, model, requireLive: false, observeProbe })).resolves.toMatchObject({ buildId });
      for (const route of ['sample', 'samples']) {
        expect(observeProbe).toHaveBeenCalledWith(route, expect.objectContaining({ status: 200, elapsedMs: expect.any(Number),
          r2Reads: expect.any(Number), r2Bytes: expect.any(Number), responseCache: expect.any(String) }));
      }
    } finally { await worker.stop(); }
  } finally {
    await local.dispose();
    await fixture.dispose();
  }
});
