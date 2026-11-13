import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { gridToGeographic, manifestV5Schema, profileResponseSchema, sampleResponseV5Schema } from '@av/contracts';
import { buildForecast } from '../apps/batch/src/build.js';
import { createWrfZarrProvider } from '../apps/batch/src/wrf-zarr/provider.js';
import { WRF_ZARR_CYCLE, WRF_ZARR_FIXTURE } from './fixtures/wrf-zarr-product.js';
import { createWrfFixtureStore } from './fixtures/wrf-zarr-store.js';
import { denseFixtureMask, syntheticWholeDomain } from './fixtures/whole-domain.js';
import { seedLocalBuild } from './sample-preview.js';

it('builds producer-encoded Zarr into v5 and serves its tiles, samples and model-level profiles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-wrf-zarr-preview-')), product = WRF_ZARR_FIXTURE;
  try {
    const manifestPath = await buildForecast({ out: root, product, provider: createWrfZarrProvider(product),
      cycle: WRF_ZARR_CYCLE, sourceStore: createWrfFixtureStore(), mask: denseFixtureMask(product, product.grid),
      wholeDomain: await syntheticWholeDomain(root, product), deriveOptions: { daylightOnly: false } });
    const manifest = manifestV5Schema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    expect(manifest.frames).toHaveLength(2);
    const persistTo = join(root, 'state');
    await seedLocalBuild({ manifestPath, persistTo, trustedProduct: product });
    const { unstable_dev } = await import('wrangler');
    const worker = await unstable_dev(fileURLToPath(new URL('../apps/api/test/wrf-zarr-fixture-worker.ts', import.meta.url)), {
      config: fileURLToPath(new URL('../apps/api/wrangler.json', import.meta.url)),
      local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: true, persistTo,
      vars: { AV_LOCAL_DEVELOPMENT: 'true' }, envFiles: [], logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false }
    });
    try {
      const origin = `http://${worker.address}:${worker.port}`, pinned = `/v1/models/${product.modelId}/runs/${manifest.buildId}`;
      const read = async (path: string) => {
        const response = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
        expect(response.status, response.ok ? path : await response.clone().text()).toBe(200);
        return response;
      };
      await read(`/v1/models/${product.modelId}/latest?expand=manifest`);
      expect(await (await read('/v1/catalog')).json()).toMatchObject({ models: [expect.objectContaining({ model: product.modelId, available: true })] });
      const point = gridToGeographic(product.grid, 2, 1)!, query = `lat=${point.lat}&lon=${point.lon}&frame=f001`;
      const sample = sampleResponseV5Schema.parse(await (await read(`${pinned}/sample?${query}&layers=precip-rate,sfc-temp-c,usable-lift-agl`)).json());
      expect(sample.frames[0]!.layers['precip-rate']).toMatchObject({ value: 1.75, status: 'valid' });
      expect(sample.frames[0]!.layers['sfc-temp-c'].value).toBeCloseTo(20.725, 1);
      expect(sample.frames[0]!.layers['usable-lift-agl'].surfaceId).toBe('fine');
      const profile = profileResponseSchema.parse(await (await read(`${pinned}/profile?${query}`)).json());
      const column = profile.frames[0]!.profile;
      expect(column.modelTerrainM).toBe(107);
      expect(column.levels.map(level => level.pressureHpa)).toEqual([949.9, 899.9, 849.9]);
      expect(column.levels[0]).toMatchObject({ uWindMps: 11.75, vWindMps: -4.12, omegaPaS: -0.3 });
      const tile = await read(`/tiles/${product.modelId}/${manifest.buildId}/precip-rate/f001/0/0/0.webp`);
      expect(tile.headers.get('content-type')).toBe('image/webp');
      expect(Buffer.from(await tile.arrayBuffer()).subarray(8, 12).toString()).toBe('WEBP');
    } finally { await worker.stop(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
