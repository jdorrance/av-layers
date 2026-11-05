import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalGridJson, planWholeDomainGrid, setBit, sparseCoverageFromDense, type RegularLatLonGrid } from '@av/contracts';
import { deriveFrame } from '@av/forecast/frame';
import { preparePackedTerrainColumns } from '@av/forecast/refinement';
import { normalizedFixtureFrame } from '../../../../scripts/fixtures/normalized-provider.js';
import { createWholeDomainDerivePool } from './derive-pool.js';
import { createNormalizedFrameTarget } from '../provider.js';

it('admits native clearance copies even when every frame buffer is already shared', async () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 2, height: 2, earthRadiusM: 6371229,
    lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 2), fineCells = plan.fine.width * plan.fine.height;
  const bits = new Uint8Array(Math.ceil(fineCells / 8));
  for (let i = 0; i < fineCells; i++) setBit(bits, i);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: createHash('sha256').update(canonicalGridJson(plan.fine)).digest('hex'),
    output: bits, halo: new Uint8Array(bits.length) });
  const activeIndices = new Uint32Array(new SharedArrayBuffer(16)); activeIndices.set([0, 1, 2, 3]);
  const frame = normalizedFixtureFrame(native, activeIndices, '2026-03-20T00:00:00Z', 12, 1);
  Object.assign(frame, createNormalizedFrameTarget(4, 3, false, false), { activeIndices });
  const size = coverage.offsets[coverage.blockIds.length]!, field = () => ({ values: new Float32Array(new SharedArrayBuffer(size * 4)), flags: new Uint8Array(new SharedArrayBuffer(size)) });
  const pool = await createWholeDomainDerivePool({ plan, coverage, activeIndices, maxLevels: 3,
    terrain: { elevationM: new Float32Array(size), valid: new Uint8Array(size) },
    output: { 'usable-lift-msl': field(), 'usable-lift-agl': field() }, workers: 1, maxFrameCopyBytes: 39 });
  try {
    await expect(pool.derive({ generation: 0, frame, time: { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' },
      nativeClearance: { grid: native, validTime: '2026-03-20T12:00:00Z', flags: new Uint8Array(4),
        diagnostics: { ceilingMslM: new Float32Array(4), buoyancyM2S3: new Float32Array(4), branch: new Uint8Array(4) } } })).rejects.toThrow('copy budget exceeded');
  } finally { await pool.close(); }
});

it.each(['isobaric', 'model-levels'] as const)('matches serial packed derivation across generations and drains failure for %s', async coordinate => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 4, height: 3, earthRadiusM: 6371229,
    lon0: -180, lat0: 1, dx: 90, dy: -1, wrapLongitude: true };
  const plan = planWholeDomainGrid(native, 5), cells = plan.fine.width * plan.fine.height;
  const outputMask = new Uint8Array(Math.ceil(cells / 8)), halo = new Uint8Array(outputMask.length);
  for (let i = 0; i < cells; i++) if (i % 11) setBit(i % 7 ? outputMask : halo, i);
  const gridHash = createHash('sha256').update(canonicalGridJson(plan.fine)).digest('hex');
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash, output: outputMask, halo });
  const activeIndices = Uint32Array.from({ length: native.width * native.height }, (_, i) => i);
  const source = normalizedFixtureFrame(native, activeIndices, '2026-03-20T00:00:00Z', 12, 1);
  const pressure = source.pressureLevelsHpa.map(value => new Float32Array(activeIndices.length).fill(value * 100));
  const frame = coordinate === 'isobaric' ? source : { ...source, pressureLevelsHpa: undefined, pressurePa: pressure,
    missing: { ...source.missing, pressure: pressure.map(() => new Uint8Array(activeIndices.length)) } };
  const size = coverage.offsets[coverage.blockIds.length]!;
  const terrain = { elevationM: new Float32Array(size).fill(100), valid: new Uint8Array(size).fill(1) };
  terrain.valid[3] = 0; terrain.elevationM[4] = -1200;
  const field = () => ({ values: new Float32Array(new SharedArrayBuffer(size * 4)), flags: new Uint8Array(new SharedArrayBuffer(size)) });
  const output = { 'usable-lift-msl': field(), 'usable-lift-agl': field() };
  const serial = preparePackedTerrainColumns(plan, coverage, activeIndices, 3, { maxBytes: 10_000_000, expectedGridHash: gridHash, clearanceFallback: 'unsupported' });
  const pool = await createWholeDomainDerivePool({ plan, coverage, activeIndices, maxLevels: 3, terrain, output, workers: 3, maxFrameCopyBytes: 1_000_000 });
  const time = { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' };
  try {
    for (let generation = 0; generation < 3; generation++) {
      frame.temp2mK[0] += generation;
      const mask = { grid: native, output: new Uint8Array(Math.ceil(activeIndices.length / 8)).fill(255), halo: new Uint8Array(Math.ceil(activeIndices.length / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
      const diagnostics = { ceilingMslM: new Float32Array(activeIndices.length), buoyancyM2S3: new Float32Array(activeIndices.length), branch: new Uint8Array(activeIndices.length) };
      const flags = deriveFrame(frame, mask, { diagnostics, daylightOnly: false })['usable-lift-msl']!.flags;
      const nativeClearance = { validTime: time.validTime, grid: native, diagnostics, flags };
      const daylightOnly = generation === 2;
      const expected = serial.derive(frame, terrain, time, { daylightOnly, nativeClearance });
      const actual = await pool.derive({ generation, frame, time, daylightOnly, nativeClearance });
      expect(actual.metrics).toEqual(expected.metrics);
      for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
        expect(new Uint8Array(actual.fields[layer].values.buffer)).toEqual(new Uint8Array(expected.fields[layer].values.buffer));
        expect(actual.fields[layer].flags).toEqual(expected.fields[layer].flags);
      }
    }
    await expect(pool.derive({ generation: 2, frame, time })).rejects.toThrow('generation');
    const invalid = { ...frame, activeIndices: Uint32Array.of(999) };
    await expect(pool.derive({ generation: 3, frame: invalid, time })).rejects.toThrow('active-index identity mismatch');
    const snapshot = new Uint8Array(output['usable-lift-agl'].values.buffer).slice();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(new Uint8Array(output['usable-lift-agl'].values.buffer)).toEqual(snapshot);
    await expect(pool.derive({ generation: 3, frame, time })).rejects.toThrow('active-index identity mismatch');
  } finally { await pool.close(); }
}, 30_000);

it('terminates every active writer before an aborted generation rejects', async () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 41, height: 41, earthRadiusM: 6371229,
    lon0: 0, lat0: 40, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 10), cells = plan.fine.width * plan.fine.height;
  const bits = new Uint8Array(Math.ceil(cells / 8));
  for (let i = 0; i < cells; i++) setBit(bits, i);
  const gridHash = createHash('sha256').update(canonicalGridJson(plan.fine)).digest('hex');
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash, output: bits, halo: new Uint8Array(bits.length) });
  const activeIndices = Uint32Array.from({ length: native.width * native.height }, (_, i) => i);
  const frame = normalizedFixtureFrame(native, activeIndices, '2026-03-20T00:00:00Z', 12, 1);
  const size = coverage.offsets[coverage.blockIds.length]!;
  const terrain = { elevationM: new Float32Array(size).fill(100), valid: new Uint8Array(size).fill(1) };
  const field = () => ({ values: new Float32Array(new SharedArrayBuffer(size * 4)), flags: new Uint8Array(new SharedArrayBuffer(size)) });
  const output = { 'usable-lift-msl': field(), 'usable-lift-agl': field() };
  const controller = new AbortController();
  const pool = await createWholeDomainDerivePool({ plan, coverage, activeIndices, maxLevels: 3, terrain, output, workers: 3,
    maxFrameCopyBytes: 1_000_000, signal: controller.signal });
  const time = { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' };
  try {
    const pending = pool.derive({ generation: 0, frame, time, daylightOnly: false });
    const interval = setInterval(() => {
      if (output['usable-lift-agl'].values.some(Number.isFinite)) controller.abort(new Error('stop active writers'));
    }, 5);
    try { await expect(pending).rejects.toThrow('stop active writers'); } finally { clearInterval(interval); }
    const snapshot = new Uint8Array(output['usable-lift-agl'].values.buffer).slice();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(new Uint8Array(output['usable-lift-agl'].values.buffer)).toEqual(snapshot);
  } finally { await pool.close(); }
}, 30_000);
