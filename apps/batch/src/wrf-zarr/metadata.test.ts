import { expect, it } from 'vitest';
import { WRF_ZARR_CYCLE, WRF_ZARR_FIXTURE } from '../../../../scripts/fixtures/wrf-zarr-product.js';
import { createWrfFixtureStore } from '../../../../scripts/fixtures/wrf-zarr-store.js';
import { readRun } from './ready.js';
import { validateMetadata } from './metadata.js';

const nextTurn = () => new Promise<void>(resolve => setImmediate(resolve));

it('authenticates all metadata and coordinates with at most four concurrent reads', async () => {
  const store = createWrfFixtureStore(), get = store.get;
  let active = 0, peak = 0, requests = 0;
  store.get = async (...args) => {
    requests++; active++; peak = Math.max(peak, active);
    try { await nextTurn(); return await get(...args); }
    finally { active--; }
  };
  await validateMetadata(await readRun(WRF_ZARR_FIXTURE, { cycle: WRF_ZARR_CYCLE, store }));
  expect({ requests, peak, active }).toEqual({ requests: 38, peak: 4, active: 0 });
});

it.each(['failure', 'abort'])('drains admitted metadata reads and stops admission on %s', async action => {
  const store = createWrfFixtureStore(), get = store.get, controller = new AbortController();
  const run = await readRun(WRF_ZARR_FIXTURE, { cycle: WRF_ZARR_CYCLE, store, signal: controller.signal });
  let release!: () => void, markStarted!: () => void;
  const drain = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  const failure = new Error('metadata transport failed');
  let active = 0, requests = 0, settled = false;
  store.get = async (...args) => {
    if (args[0].endsWith('/forecast.zarr/zarr.json')) return get(...args);
    const ordinal = requests++;
    active++;
    if (requests === 4) markStarted();
    try {
      await Promise.resolve();
      if (action === 'failure' && ordinal === 0) throw failure;
      await drain;
      return await get(...args);
    } finally { active--; }
  };
  const validation = validateMetadata(run).finally(() => { settled = true; });
  const rejected = expect(validation).rejects.toBe(failure);
  await started;
  if (action === 'abort') controller.abort(failure);
  await nextTurn();
  expect(settled).toBe(false);
  expect(requests).toBe(4);
  release();
  await rejected;
  expect({ requests, active }).toEqual({ requests: 4, active: 0 });
});
