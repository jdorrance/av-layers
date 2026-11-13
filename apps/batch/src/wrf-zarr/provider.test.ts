import { createHash } from 'node:crypto';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { expect, it } from 'vitest';
import { validateNormalizedFrame, type NormalizedFrame } from '@av/forecast/inputs';
import { createNormalizedFrameTarget, type ForecastSourceStore } from '../provider.js';
import { createWrfZarrProvider } from './provider.js';
import { WRF_ZARR_CYCLE, WRF_ZARR_FIXTURE } from '../../../../scripts/fixtures/wrf-zarr-product.js';
import { createWrfFixtureStore } from '../../../../scripts/fixtures/wrf-zarr-store.js';
import ready from '../../../../scripts/fixtures/wrf-zarr/_ready.json' with { type: 'json' };
import oracle from '../../../../scripts/fixtures/wrf-zarr/oracle.json' with { type: 'json' };
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };

const prefix = `upstream/${ready.model_id}/${ready.cycle_partition}/`, readyKey = `${prefix}_ready.json`;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const selected = Uint32Array.of(14, 0, 7), options = { cycle: WRF_ZARR_CYCLE, cacheDir: 'unused', activeIndices: selected };

function fixture() {
  const receipt = structuredClone(ready), original = createWrfFixtureStore();
  const objects = new Map<string, Uint8Array | null>(), reads: string[] = [];
  const store: ForecastSourceStore = { head: original.head,
    async get(key, range, maximum, signal, onRetry, identity) {
      signal?.throwIfAborted();
      reads.push(key);
      if (key === readyKey) return { bytes: Buffer.from(JSON.stringify(receipt)), etag: 'receipt' };
      if (!objects.has(key)) return original.get(key, range, maximum, signal, onRetry, identity);
      const bytes = objects.get(key);
      return bytes ? { bytes, etag: digest(bytes) } : null;
    }
  };
  return { receipt, store, objects, reads, provider: createWrfZarrProvider(WRF_ZARR_FIXTURE),
    async replace(name: string, update: (bytes: Buffer) => Uint8Array) {
      const key = `${prefix}forecast.zarr/${name}`, found = await original.get(key, undefined, 1024 * 1024);
      if (!found) throw new Error(`Missing test object ${name}`);
      const bytes = update(Buffer.from(found.bytes));
      objects.set(key, bytes);
      receipt.shard_sha256s.find(entry => entry[0] === name)![1] = digest(bytes);
    }
  };
}

function valuesAt(frame: NormalizedFrame, slot: number) {
  const surface = frame.auxSurface!, levels = frame.auxLevels!;
  return {
    terrain_m: frame.terrainM[slot], surface_pressure_pa: frame.surfacePressurePa[slot], temp_2m_k: frame.temp2mK[slot],
    spfh_2m_kgkg: frame.specificHumidity2mKgKg[slot], sensible_heat_flux_wm2: frame.sensibleHeatFluxWm2[slot],
    latent_heat_flux_wm2: frame.latentHeatFluxWm2[slot], precip_mm_hr: frame.precipitationMmPerHour![slot],
    mslp_pa: surface.mslpPa!.values[slot], u_10m_earth_mps: surface.u10mMps!.values[slot], v_10m_earth_mps: surface.v10mMps!.values[slot],
    gust_10m_mps: surface.gust10mMps!.values[slot], pbl_height_m: surface.pblHeightM!.values[slot], cape_jkg: surface.capeJkg!.values[slot],
    cloud_total_pct: surface.cloudTotalPct!.values[slot], cloud_low_pct: surface.cloudLowPct!.values[slot],
    pressure_pa: frame.pressurePa!.map(field => field[slot]), height_msl_m: frame.hgtM.map(field => field[slot]), temp_k: frame.tempK.map(field => field[slot]),
    spfh_kgkg: levels.spfhKgKg!.map(field => field.values[slot]), u_earth_mps: levels.uWindMps!.map(field => field.values[slot]),
    v_earth_mps: levels.vWindMps!.map(field => field.values[slot]), omega_pas: levels.omegaPaS!.map(field => field.values[slot])
  };
}

it('matches zarr-python across all 22 fields, sparse cell order, levels and times while reusing target buffers', async () => {
  const { store, provider } = fixture();
  const resolved = await provider.resolveRun!({ cacheDir: options.cacheDir, store });
  expect(resolved).toMatchObject({ cycle: WRF_ZARR_CYCLE, sourcePin: { key: readyKey } });
  const active = selected.slice(), session = await provider.open({ ...options, store, activeIndices: active, sourcePin: resolved.sourcePin });
  active.fill(2);
  const target = createNormalizedFrameTarget(selected.length, 3, true, true);
  try {
    const frames = [];
    for (const hour of [1, 2]) {
      const frame = await session.acquire(hour, target);
      frames.push(frame);
      expect(frame.activeIndices).toEqual(selected);
      validateNormalizedFrame(frame, selected, WRF_ZARR_FIXTURE.grid, 3, WRF_ZARR_FIXTURE.layers, 'model-levels');
      expect(frame.terrainM).toBe(target.terrainM);
      expect(frame.tempK[2]).toBe(target.tempK[2]);
      expect(frame.missing.pressure![1]).toBe(target.missing.pressure![1]);
      for (const sample of oracle.samples.filter(sample => sample.timeIndex === hour - 1)) {
        const slot = selected.indexOf(sample.y * WRF_ZARR_FIXTURE.grid.width + sample.x);
        expect(valuesAt(frame, slot)).toEqual(sample.fields);
      }
      expect(frame.intervals).toMatchObject({ usedCompanion: false, profileTime: ready.valid_times_utc[hour - 1],
        fluxWindow: { start: ready.window_starts_utc[hour - 1], end: ready.window_ends_utc[hour - 1] } });
      expect(frame.receipt.sourcePin).toEqual(resolved.sourcePin);
      expect(frame.receipt).toMatchObject({ schemaVersion: contract.schemaVersion,
        definitions: { verticalCoordinate: contract.verticalCoordinate, temperature: contract.temperatureDefinition,
          moistureSourceOfTruth: contract.moistureSourceOfTruth, capeParcel: contract.capeParcelDefinition, lowCloud: contract.lowCloudDefinition,
          windReference: 'earth-relative', gust: 'ifs-cy43r1-instantaneous-turbulent-gust', omega: 'moist-hydrostatic-proxy-minus-rho-g-w' } });
    }
    expect(frames[1]!.auxSurface!.u10mMps!.values).toBe(frames[0]!.auxSurface!.u10mMps!.values);
    expect(frames[1]!.auxLevels!.omegaPaS![2]!.missing).toBe(frames[0]!.auxLevels!.omegaPaS![2]!.missing);
    expect(session.stats).toMatchObject({ frames: 2, sourceBytes: expect.any(Number) });
    await expect(session.acquire(3)).rejects.toThrow('hour is unavailable');
  } finally { await session.close(); }
  await expect(session.acquire(1)).rejects.toThrow('closed');
});

it.each<[string, (receipt: typeof ready) => void]>([
  ['model', receipt => { receipt.model_id = 'another-model'; }],
  ['grid', receipt => { receipt.grid.width++; }],
  ['levels', receipt => { receipt.exported_levels_k++; }],
  ['missing hour', receipt => { receipt.lead_hours.pop(); }],
  ['unordered hours', receipt => { receipt.lead_hours.reverse(); }],
  ['window', receipt => { receipt.window_starts_utc[1] = receipt.window_starts_utc[0]!; }],
  ['field order', receipt => { receipt.field_names.reverse(); }],
  ['duplicate object', receipt => { receipt.shard_sha256s.push([...receipt.shard_sha256s[0]!]); }],
  ['missing object', receipt => { receipt.shard_sha256s.pop(); }],
  ['traversal', receipt => { receipt.shard_sha256s[0]![0] = '../other.zarr/zarr.json'; }]
])('rejects a receipt with invalid %s before reading Zarr data', async (_name, change) => {
  const { receipt, store, provider, reads } = fixture();
  change(receipt);
  await expect(provider.open({ ...options, store })).rejects.toThrow();
  expect(reads).toEqual([readyKey]);
});

it('pins the receipt and rejects changed content, cross-model keys and unbound pins', async () => {
  const { receipt, store, provider } = fixture();
  const { sourcePin } = await provider.resolveRun!({ ...options, store });
  await expect(provider.open({ ...options, store, sourcePin: { ...sourcePin, key: readyKey.replace('wrf-fixture', 'other') } })).rejects.toThrow('receipt key');
  await expect(provider.open({ ...options, store, sourcePin, cycle: undefined })).rejects.toThrow('explicit cycle');
  receipt.config_sha256 = '1'.repeat(64);
  await expect(provider.open({ ...options, store, sourcePin })).rejects.toThrow('changed after admission');
});

it('reads an immutable hosted payload under its admitted attempt and manifest digest', async () => {
  const { receipt, store, provider } = fixture(), requests: string[] = [];
  receipt.zarr_relpath = `attempts/${receipt.attempt_id}/${'a'.repeat(64)}/forecast.zarr`;
  const hosted = `${prefix}${receipt.zarr_relpath}/`, get = store.get;
  store.get = async (key, ...args) => {
    requests.push(key);
    return get(key.replace(hosted, `${prefix}forecast.zarr/`), ...args);
  };
  const session = await provider.open({ ...options, store });
  try {
    const frame = await session.acquire(1);
    expect(frame.temp2mK[0]).toBe(294.75);
    expect(requests.some(key => key.startsWith(hosted))).toBe(true);
    expect(requests.every(key => key === readyKey || key.startsWith(hosted))).toBe(true);
  } finally { await session.close(); }
});

it.each([
  `attempts/other/${'a'.repeat(64)}/forecast.zarr`,
  `attempts/fixture/../${'a'.repeat(64)}/forecast.zarr`,
  'attempts/fixture/short/forecast.zarr',
  '../forecast.zarr'
])('rejects a cross-attempt or unsafe hosted payload path: %s', async zarrRelpath => {
  const { receipt, store, provider, reads } = fixture();
  receipt.zarr_relpath = zarrRelpath;
  await expect(provider.open({ ...options, store })).rejects.toThrow('payload path');
  expect(reads).toEqual([readyKey]);
});

it.each(['.', '..', 'a/b'])('rejects unsafe attempt identities before resolving their payload: %s', async attempt => {
  const { receipt, store, provider, reads } = fixture();
  receipt.attempt_id = attempt;
  receipt.zarr_relpath = `attempts/${attempt}/${'a'.repeat(64)}/forecast.zarr`;
  await expect(provider.open({ ...options, store })).rejects.toThrow();
  expect(reads).toEqual([readyKey]);
});

it.each(['latest model', 'latest key', 'missing ready'])('rejects %s during discovery', async failure => {
  const { store, provider } = fixture();
  const get = store.get;
  store.get = async (...args) => {
    if (failure === 'missing ready' && args[0] === readyKey) return null;
    if (args[0].endsWith('/latest.json')) {
      const pointer = { model_id: ready.model_id, cycle_partition: ready.cycle_partition,
        publish_origin_utc: ready.publish_origin_utc, ready_key: readyKey };
      if (failure === 'latest model') pointer.model_id = 'other';
      if (failure === 'latest key') pointer.ready_key = readyKey.replace('/00/', '/06/');
      return { bytes: Buffer.from(JSON.stringify(pointer)), etag: '' };
    }
    return get(...args);
  };
  await expect(provider.resolveCycle({ cacheDir: options.cacheDir, store })).rejects.toThrow(/receipt (key|unavailable)/);
});

it.each<[string, string, (metadata: Record<string, unknown>) => void]>([
  ['shape', 'temp_k/zarr.json', metadata => { metadata.shape = [2, 2, 3, 5]; }],
  ['units', 'temp_2m_k/zarr.json', metadata => { metadata.attributes = { units: 'C' }; }],
  ['codec', 'pressure_pa/zarr.json', metadata => { metadata.codecs = [{ name: 'gzip' }]; }],
  ['group', 'zarr.json', metadata => { metadata.attributes = { ...(metadata.attributes as object), vertical_coordinate: 'isobaric' }; }],
  ['coordinate type', 'x/zarr.json', metadata => { metadata.data_type = 'float32'; }]
])('rejects authenticated but incompatible %s metadata', async (_name, key, change) => {
  const { store, provider, replace } = fixture();
  await replace(key, bytes => { const metadata = JSON.parse(bytes.toString()) as Record<string, unknown>; change(metadata); return Buffer.from(JSON.stringify(metadata)); });
  await expect(provider.open({ ...options, store })).rejects.toThrow(/metadata/);
});

it.each(['x/c/0', 'time/c/0', 'valid_time_unix_s/c/0'])('rejects authenticated coordinates inconsistent with the receipt: %s', async key => {
  const { store, provider, replace } = fixture();
  await replace(key, bytes => { bytes[0] = bytes[0]! ^ 1; return bytes; });
  await expect(provider.open({ ...options, store })).rejects.toThrow('coordinate differs');
});

it.each(['missing', 'corrupt', 'oversized'])('rejects a %s committed weather shard', async failure => {
  const { store, provider, objects } = fixture();
  const session = await provider.open({ ...options, store });
  const key = `${prefix}forecast.zarr/temp_k/c/0/0/0/0`;
  const bytes = (await store.get(key, undefined, 1024 * 1024))!.bytes.slice();
  bytes[0] = bytes[0]! ^ 1;
  objects.set(key, failure === 'missing' ? null : failure === 'oversized' ? new Uint8Array(1024 * 1024) : bytes);
  try { await expect(session.acquire(1)).rejects.toThrow(/missing, oversized or SHA-256 mismatch/); }
  finally { await session.close(); }
});

it.each([false, true])('preserves or weights existing three-hour flux and precipitation windows (aggregate=%s)', async aggregate => {
  const { receipt, store, replace } = fixture();
  receipt.lead_hours[1] = 4;
  receipt.valid_times_utc[1] = receipt.window_ends_utc[1] = '2026-11-13T04:00:00Z';
  await replace('zarr.json', bytes => { const doc = JSON.parse(bytes.toString()); doc.attributes.lead_hours = [1, 4]; return Buffer.from(JSON.stringify(doc)); });
  await replace('time/c/0', bytes => { bytes.writeInt32LE(4, 4); return bytes; });
  for (const name of ['valid_time_unix_s', 'window_end_unix_s']) await replace(`${name}/c/0`, bytes => { bytes.writeBigInt64LE(BigInt(Date.parse(receipt.valid_times_utc[1]!) / 1000), 8); return bytes; });
  const model = { ...WRF_ZARR_FIXTURE, frameHours: aggregate ? [4] : [1, 4], intervalHours: aggregate ? 4 : 1,
    intervalChange: aggregate ? undefined : { fromHour: 4, hours: 3 } };
  const session = await createWrfZarrProvider(model).open({ ...options, store });
  try {
    const frame = await session.acquire(4);
    expect(frame.intervals.fluxWindow).toEqual({ start: aggregate ? '2026-11-13T00:00:00Z' : '2026-11-13T01:00:00Z', end: '2026-11-13T04:00:00Z' });
    expect(frame.intervals.precipitationWindow).toEqual(frame.intervals.fluxWindow);
    expect(frame.intervals.usedCompanion).toBe(aggregate);
    expect(frame.precipitationMmPerHour![0]).toBe(aggregate ? 4.25 : 4.5);
    expect(frame.sensibleHeatFluxWm2[0]).toBe(aggregate ? 271.5 : 274);
  } finally { await session.close(); }
});

it.each([false, true])('averages hourly windows, preserves ending profiles and unions missingness (missing=%s)', async missing => {
  const { store, replace } = fixture();
  if (missing) await replace('sensible_heat_flux_wm2/c/0/0/0', bytes => {
    const raw = zstdDecompressSync(bytes.subarray(0, -20));
    raw.writeFloatLE(NaN, 0);
    const compressed = zstdCompressSync(raw), index = Buffer.alloc(20);
    index.writeBigUInt64LE(BigInt(compressed.length), 8);
    let crc = 0xffffffff;
    for (const byte of index.subarray(0, 16)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
    }
    index.writeUInt32LE((crc ^ 0xffffffff) >>> 0, 16);
    return Buffer.concat([compressed, index]);
  });
  const model = { ...WRF_ZARR_FIXTURE, frameHours: [2], intervalHours: 2 };
  const session = await createWrfZarrProvider(model).open({ ...options, store });
  try {
    const frame = await session.acquire(2);
    expect(frame.intervals).toMatchObject({ usedCompanion: true,
      fluxWindow: { start: ready.window_starts_utc[0], end: ready.window_ends_utc[1] } });
    expect(frame.precipitationMmPerHour![0]).toBe(4);
    expect(frame.sensibleHeatFluxWm2[0]).toBe(269);
    expect(frame.temp2mK[0]).toBe(295.75);
    expect(frame.pressurePa![2]![0]).toBe(84982);
    expect(frame.missing.sensibleHeatFlux).toEqual(Uint8Array.of(0, Number(missing), 0));
    validateNormalizedFrame(frame, selected, model.grid, 3, model.layers, 'model-levels');
  } finally { await session.close(); }
});

it('requires source windows to cover each configured interval exactly', async () => {
  const { store } = fixture();
  for (const intervalHours of [1.5, 3]) {
    const provider = createWrfZarrProvider({ ...WRF_ZARR_FIXTURE, frameHours: [2], intervalHours });
    await expect(provider.open({ ...options, store })).rejects.toThrow('do not cover the configured interval');
  }
});

it.each(['close', 'abort'])('cancels pending acquisition through %s and rejects overlapping acquisition', async action => {
  const { store, provider } = fixture(), controller = new AbortController();
  const session = await provider.open({ ...options, store, signal: controller.signal });
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  store.get = async (_key, _range, _maximum, signal) => {
    markStarted();
    return new Promise((_resolve, reject) => { signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }); });
  };
  const pending = session.acquire(1);
  const failed = expect(pending).rejects.toThrow();
  await started;
  await expect(session.acquire(2)).rejects.toThrow('already running');
  if (action === 'close') await session.close();
  else controller.abort(new Error('test cancellation'));
  await failed;
  await session.close();
});
