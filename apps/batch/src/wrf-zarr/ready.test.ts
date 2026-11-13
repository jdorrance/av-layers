import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { gridToGeographic } from '@av/contracts';
import { validateNormalizedFrame } from '@av/forecast/inputs';
import { WRF_ZARR_FIXTURE } from '../../../../scripts/fixtures/wrf-zarr-product.js';
import { createWrfFixtureStore } from '../../../../scripts/fixtures/wrf-zarr-store.js';
import ready from '../../../../scripts/fixtures/wrf-zarr/_ready.json' with { type: 'json' };
import oracle from '../../../../scripts/fixtures/wrf-zarr/oracle.json' with { type: 'json' };
import type { ForecastSourceStore } from '../provider.js';
import { createWrfZarrProvider } from './provider.js';
import { readRun } from './ready.js';

it('discovers the configured producer model independently of its public catalog identity', async () => {
  const model = { ...WRF_ZARR_FIXTURE, modelId: 'public-forecast',
    upstream: { ...WRF_ZARR_FIXTURE.upstream, modelId: WRF_ZARR_FIXTURE.modelId } };
  const store = createWrfFixtureStore(), get = store.get, keys: string[] = [];
  store.get = async (key, ...args) => { keys.push(key); return get(key, ...args); };
  const run = await readRun(model, { store });
  expect(keys[0]).toBe(`upstream/${WRF_ZARR_FIXTURE.modelId}/latest.json`);
  expect(run.receipt.model_id).toBe(WRF_ZARR_FIXTURE.modelId);
  expect(run.pin.key).toBe(keys[1]);
  await expect(readRun(model, { store, cycle: run.cycle, sourcePin: {
    ...run.pin, key: run.pin.key.replace(WRF_ZARR_FIXTURE.modelId, model.modelId)
  } })).rejects.toThrow('receipt key');
});

it('serves independently pinned northern and southern domains through the same provider', async () => {
  const base = WRF_ZARR_FIXTURE.grid, pins = new Set<string>(), values = oracle.samples[0]!.fields;
  if (base.kind !== 'lambert-conformal') throw new Error('Expected Lambert fixture');
  const original = createWrfFixtureStore(), originalPrefix = `upstream/${ready.model_id}/${ready.cycle_partition}/`;
  const originalGroup = (await original.get(`${originalPrefix}forecast.zarr/zarr.json`, undefined, 16 * 1024))!;
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  for (const [domain, sign, meridian, x0, y0] of [['north', 1, 44.5, -6000, -3000], ['south', -1, 173, 100000, 200000]] as const) {
    const sourceModel = `source-${domain}`, prefix = `upstream/${sourceModel}/${ready.cycle_partition}/`;
    const grid = { ...base, centralMeridianDeg: meridian, latitudeOfOriginDeg: sign * 40.2,
      standardParallel1Deg: sign * 38.5, standardParallel2Deg: sign * 41.8, x0M: x0, y0M: y0 };
    const corners = [[0, 0], [0, grid.height - 1], [grid.width - 1, 0], [grid.width - 1, grid.height - 1]]
      .map(([x, y]) => gridToGeographic(grid, x!, y!)!);
    const bounds = [Math.min(...corners.map(point => point.lon)), Math.min(...corners.map(point => point.lat)),
      Math.max(...corners.map(point => point.lon)), Math.max(...corners.map(point => point.lat))] as const;
    const model = { ...WRF_ZARR_FIXTURE, modelId: `public-${domain}`, grid, bounds,
      source: { modelFamily: 'wrf', configurationId: `configured-${domain}`, domainId: domain },
      upstream: { ...WRF_ZARR_FIXTURE.upstream, modelId: sourceModel } };
    const receipt = structuredClone(ready), group = JSON.parse(Buffer.from(originalGroup.bytes).toString());
    receipt.model_id = sourceModel; receipt.grid = { ...receipt.grid, ...grid }; group.attributes.grid = grid;
    for (const [name, value] of [['Central_Meridian', meridian], ['Latitude_Of_Origin', grid.latitudeOfOriginDeg],
      ['Standard_Parallel_1', grid.standardParallel1Deg], ['Standard_Parallel_2', grid.standardParallel2Deg]]) {
      group.attributes.crs_wkt = group.attributes.crs_wkt.replace(new RegExp(`PARAMETER\\["${name}",[^\\]]+\\]`), `PARAMETER["${name}",${value}]`);
    }
    const changed = new Map<string, Uint8Array>([['zarr.json', Buffer.from(JSON.stringify(group))]]);
    for (const [name, count, origin, step] of [['x', grid.width, x0, grid.dxM], ['y', grid.height, y0, grid.dyM]] as const) {
      const bytes = Buffer.alloc(count * 8);
      for (let i = 0; i < count; i++) bytes.writeDoubleLE(origin + i * step, i * 8);
      changed.set(`${name}/c/0`, bytes);
    }
    for (const [name, bytes] of changed) receipt.shard_sha256s.find(entry => entry[0] === name)![1] = digest(bytes);
    const store: ForecastSourceStore = {
      async head() { throw new Error('Provider must use authenticated reads'); },
      async get(key, range, maximum, signal) {
        signal?.throwIfAborted();
        if (key === `upstream/${sourceModel}/latest.json`) return { bytes: Buffer.from(JSON.stringify({ model_id: sourceModel,
          cycle_partition: receipt.cycle_partition, publish_origin_utc: receipt.publish_origin_utc, ready_key: `${prefix}_ready.json` })), etag: '' };
        if (!key.startsWith(prefix)) throw new Error('Cross-domain source read');
        if (key === `${prefix}_ready.json`) return { bytes: Buffer.from(JSON.stringify(receipt)), etag: '' };
        const name = key.slice(`${prefix}forecast.zarr/`.length), bytes = changed.get(name);
        return bytes ? { bytes, etag: digest(bytes) } : original.get(key.replace(prefix, originalPrefix), range, maximum, signal);
      }
    };
    const provider = createWrfZarrProvider(model), resolved = await provider.resolveRun!({ store, cacheDir: 'unused' });
    pins.add(resolved.sourcePin.key);
    const sample = oracle.samples[0]!, activeIndices = Uint32Array.of(sample.y * grid.width + sample.x);
    const session = await provider.open({ ...resolved, store, cacheDir: 'unused', activeIndices });
    try {
      const frame = await session.acquire(1);
      validateNormalizedFrame(frame, activeIndices, grid, 3, model.layers, 'model-levels');
      expect(frame.grid).toEqual(grid);
      expect(Math.sign(gridToGeographic(frame.grid, sample.x, sample.y)!.lat)).toBe(sign);
      expect(frame.receipt.sourcePin).toEqual(resolved.sourcePin);
      expect(provider.id).toBe(`configured-${domain}`);
      expect(frame.temp2mK[0]).toBe(values.temp_2m_k);
      expect(frame.pressurePa!.map(level => level[0])).toEqual(values.pressure_pa);
      expect(frame.auxLevels!.uWindMps!.map(level => level.values[0])).toEqual(values.u_earth_mps);
      expect(frame.auxLevels!.omegaPaS!.map(level => level.values[0])).toEqual(values.omega_pas);
    } finally { await session.close(); }
  }
  expect(pins.size).toBe(2);
});
