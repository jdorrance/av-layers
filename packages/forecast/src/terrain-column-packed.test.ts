import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { canonicalGridJson, planWholeDomainGrid, setBit, sparseCoverageFromDense, sparseCoverageLookup, STATUS_NO_LIFT, STATUS_OUTSIDE, TERRAIN_CLEARANCE_METHOD,
  type CoverageMask, type Grid, type RegularLatLonGrid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { deriveFrame, FRAME_BRANCH } from './frame.js';
import { preparePackedTerrainColumns, prepareTerrainColumns } from './refinement.js';

const day = { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' };
const gridHash = (grid: Grid) => createHash('sha256').update(canonicalGridJson(grid)).digest('hex');

function mask(grid: Grid, selected: (index: number) => number): CoverageMask {
  const bytes = Math.ceil(grid.width * grid.height / 8);
  const result = { grid, output: new Uint8Array(bytes), halo: new Uint8Array(bytes), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (let i = 0; i < grid.width * grid.height; i++) {
    const value = selected(i);
    if (value === 1) setBit(result.output, i);
    if (value === 2) setBit(result.halo, i);
  }
  return result;
}

it.each([
  { wrap: false, coordinate: 'isobaric', projected: false }, { wrap: false, coordinate: 'model-levels', projected: false },
  { wrap: true, coordinate: 'isobaric', projected: false }, { wrap: true, coordinate: 'model-levels', projected: false },
  { wrap: false, coordinate: 'isobaric', projected: true }
] as const)('matches dense reference on $coordinate $wrap grids (projected=$projected) in sparse block order', async ({ wrap, coordinate, projected }) => {
  const native: Grid = projected ? { kind: 'lambert-conformal', width: 5, height: 3, earthRadiusM: 6371229,
    centralMeridianDeg: -97.5, latitudeOfOriginDeg: 38.5, standardParallel1Deg: 38.5, standardParallel2Deg: 38.5,
    x0M: -6000, y0M: -3000, dxM: 3000, dyM: 3000, wrapLongitude: false }
    : { kind: 'regular-latlon', width: wrap ? 4 : 5, height: 3, earthRadiusM: 6371229,
      lon0: wrap ? -180 : -1.1, lat0: 1.1, dx: wrap ? 90 : 0.7, dy: -0.7, wrapLongitude: wrap };
  const plan = planWholeDomainGrid(native, 5), source = mask(native, () => 1);
  const target = mask(plan.fine, index => index % 11 === 0 ? 0 : index % 7 === 0 ? 2 : 1);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const active = Uint32Array.from({ length: native.width * native.height }, (_, i) => i);
  const sourceFrame = normalizedFixtureFrame(native, active, '2026-03-20T00:00:00Z', 12, 1);
  for (let i = 0; i < active.length; i++) {
    sourceFrame.terrainM[i] = 100 + i * 3;
    sourceFrame.temp2mK[i] = 293.15 + i * 0.05;
    sourceFrame.sensibleHeatFluxWm2[i] = i % 6 === 0 ? -100 : 250;
  }
  sourceFrame.temp2mK[0] = NaN;
  const pressure = sourceFrame.pressureLevelsHpa.map(value => new Float32Array(active.length).fill(value * 100));
  const frame = coordinate === 'isobaric' ? sourceFrame : { ...sourceFrame, pressureLevelsHpa: undefined, pressurePa: pressure,
    missing: { ...sourceFrame.missing, pressure: pressure.map(() => new Uint8Array(active.length)) } };
  const count = plan.fine.width * plan.fine.height;
  const denseTerrain = { elevationM: new Float32Array(count), valid: new Uint8Array(count).fill(1) };
  const packedTerrain = { elevationM: new Float32Array(coverage.offsets[coverage.blockIds.length]!),
    valid: new Uint8Array(coverage.offsets[coverage.blockIds.length]!).fill(1) };
  for (let i = 0; i < count; i++) {
    const elevation = [100, 99, -1200, 1600, 600, 150, 0][i % 7]!;
    denseTerrain.elevationM[i] = elevation;
    const cell = sparseCoverageLookup(coverage, i % plan.fine.width, Math.floor(i / plan.fine.width));
    if (cell) packedTerrain.elevationM[cell.offset] = elevation;
  }
  denseTerrain.valid[7] = 0;
  packedTerrain.valid[sparseCoverageLookup(coverage, 7, 0)!.offset] = 0;
  const diagnostics = { ceilingMslM: new Float32Array(active.length), buoyancyM2S3: new Float32Array(active.length), branch: new Uint8Array(active.length) };
  const flags = deriveFrame(frame, source, { daylightOnly: false, diagnostics })['usable-lift-agl']!.flags;
  const nativeClearance = { grid: native, validTime: day.validTime, diagnostics, flags };
  const dense = prepareTerrainColumns(source, target, active, 3, { clearanceFallback: 'unsupported' });
  const packed = preparePackedTerrainColumns(plan, coverage, active, 3, { clearanceFallback: 'unsupported', maxBytes: 10_000_000, expectedGridHash: gridHash(plan.fine) });
  const clearance = { daylightOnly: false, clearance: { methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: day.validTime,
    grid: plan.fine, fields: { 'usable-lift-msl': { values: new Float32Array(count), flags: new Uint8Array(count) },
      'usable-lift-agl': { values: new Float32Array(count), flags: new Uint8Array(count) } } } };
  expect(() => packed.derive(frame, packedTerrain, day, clearance)).toThrow(/packed.*clearance/i);
  await expect(packed.deriveAsync(frame, packedTerrain, day, { ...clearance,
    yieldControl: () => new Promise(resolve => setImmediate(resolve)) })).rejects.toThrow(/packed.*clearance/i);
  const probeIndices = [3, 17, plan.fine.width * 4 + 4, plan.fine.width * 9 + 7];
  const compare = async (daylightOnly: boolean) => {
    const expected = dense.derive(frame, denseTerrain, day, { daylightOnly, nativeClearance, probeIndices });
    const actual = packed.derive(frame, packedTerrain, day, { daylightOnly, nativeClearance, probeIndices });
    const asynchronous = await packed.deriveAsync(frame, packedTerrain, day, { daylightOnly, nativeClearance, probeIndices,
      yieldControl: () => new Promise(resolve => setImmediate(resolve)) });
    const output = Object.fromEntries((['usable-lift-msl', 'usable-lift-agl'] as const).map(layer => [layer, {
      values: new Float32Array(new SharedArrayBuffer(packedTerrain.valid.length * 4)),
      flags: new Uint8Array(new SharedArrayBuffer(packedTerrain.valid.length))
    }])) as { 'usable-lift-msl': { values: Float32Array; flags: Uint8Array }; 'usable-lift-agl': { values: Float32Array; flags: Uint8Array } };
    const shared = await packed.deriveAsync(frame, packedTerrain, day, { daylightOnly, nativeClearance, probeIndices, output, yieldControl: async () => {} });
    expect(shared.metrics).toEqual(actual.metrics);
    expect(shared.probes).toEqual(actual.probes);
    expect(asynchronous.metrics).toEqual(actual.metrics);
    expect(asynchronous.probes).toEqual(actual.probes);
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      expect(new Uint8Array(asynchronous.fields[layer].values.buffer)).toEqual(new Uint8Array(actual.fields[layer].values.buffer));
      expect(asynchronous.fields[layer].flags).toEqual(actual.fields[layer].flags);
      expect(shared.fields[layer].values).toBe(output[layer].values);
      expect(shared.fields[layer].flags).toBe(output[layer].flags);
      expect(new Uint8Array(shared.fields[layer].values.buffer)).toEqual(new Uint8Array(actual.fields[layer].values.buffer));
      expect(shared.fields[layer].flags).toEqual(actual.fields[layer].flags);
    }
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) { output[layer].values.fill(NaN); output[layer].flags.fill(STATUS_OUTSIDE); }
    const parts = Array.from({ length: 3 }, (_, index) => preparePackedTerrainColumns(plan, coverage, active, 3, {
      clearanceFallback: 'unsupported', maxBytes: 10_000_000, expectedGridHash: gridHash(plan.fine), partition: { index, count: 3 }
    }).derive(frame, packedTerrain, day, { daylightOnly, nativeClearance, probeIndices, output }));
    const metrics = { ...parts[0]!.metrics };
    for (const part of parts.slice(1)) for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = (metrics[key] ?? 0) + (part.metrics[key] ?? 0);
    expect(metrics).toEqual(actual.metrics);
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      expect(new Uint8Array(output[layer].values.buffer)).toEqual(new Uint8Array(actual.fields[layer].values.buffer));
      expect(output[layer].flags).toEqual(actual.fields[layer].flags);
    }
    expect(actual.metrics).toEqual(expected.metrics);
    const packedOffset = (index: number) => sparseCoverageLookup(coverage, index % plan.fine.width, Math.floor(index / plan.fine.width))!.offset;
    // Geographic projection roundtrips perturb diagnostic doubles; published Float32 fields below stay exact.
    const approximate = (value: unknown): unknown => typeof value === 'number' ? expect.closeTo(value, 8)
      : Array.isArray(value) ? value.map(approximate)
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, approximate(child)])) : value;
    const probes = [...expected.probes].sort((a, b) => packedOffset(a.index) - packedOffset(b.index));
    expect(actual.probes).toEqual(projected ? approximate(probes) : probes);
    for (let i = 0; i < count; i++) {
      const cell = sparseCoverageLookup(coverage, i % plan.fine.width, Math.floor(i / plan.fine.width));
      if (!cell) continue;
      for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
        expect(actual.fields[layer].values[cell.offset], `${i} ${layer}`).toBe(expected.fields[layer].values[i]);
        expect(new Uint32Array(actual.fields[layer].values.buffer)[cell.offset], `${i} ${layer} bits`)
          .toBe(new Uint32Array(expected.fields[layer].values.buffer)[i]);
        expect(actual.fields[layer].flags[cell.offset], `${i} ${layer}`).toBe(expected.fields[layer].flags[i]);
        expect(actual.fields[layer].coverage).toBe(coverage);
      }
    }
    return actual;
  };
  const result = await compare(false);
  expect(result.metrics.clearance).toBeGreaterThan(0);
  expect(result.metrics.column).toBeGreaterThan(0);
  expect(result.metrics.unsupportedHeight).toBeGreaterThan(0);
  expect(result.metrics.invalidDem).toBe(1);
  expect(result.metrics.missingDonor).toBeGreaterThan(0);
  await compare(true);
  diagnostics.branch[1] = FRAME_BRANCH.surfaceStable;
  diagnostics.ceilingMslM[1] = sourceFrame.terrainM[1]!;
  diagnostics.buoyancyM2S3[1] = 0;
  flags[1] = STATUS_NO_LIFT;
  await compare(false);
});

it('ignores absent zero-weight neighbors and rejects absent positive donors', () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 2, height: 2, earthRadiusM: 6371229,
    lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 2), active = Uint32Array.of(0);
  const source = mask(native, index => index === 0 ? 1 : 0);
  const target = mask(plan.fine, index => index === 0 ? 1 : 0);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const frame = normalizedFixtureFrame(native, active, '2026-03-20T00:00:00Z', 12, 1);
  const options = { maxBytes: 1_000_000, expectedGridHash: gridHash(plan.fine) };
  const packed = preparePackedTerrainColumns(plan, coverage, active, 3, options);
  const actual = packed.derive(frame, { elevationM: Float32Array.of(100), valid: Uint8Array.of(1) }, day, { daylightOnly: false });
  const reference = prepareTerrainColumns(source, target, active, 3).derive(frame,
    { elevationM: new Float32Array(9).fill(100), valid: new Uint8Array(9).fill(1) }, day, { daylightOnly: false });
  expect(actual.fields['usable-lift-agl'].values[0]).toBe(reference.fields['usable-lift-agl'].values[0]);
  expect(actual.fields['usable-lift-agl'].flags[0]).toBe(reference.fields['usable-lift-agl'].flags[0]);
  const middle = mask(plan.fine, index => index === 1 ? 1 : 0);
  const incomplete = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: middle.output, halo: middle.halo });
  expect(() => preparePackedTerrainColumns(plan, incomplete, active, 3, options)).toThrow(/donor 1/);
  expect(() => preparePackedTerrainColumns(plan, coverage, active, 3, { ...options, maxBytes: 1 })).toThrow(/byte budget/);
  const other = planWholeDomainGrid({ ...native, lon0: 10 }, 2);
  const wrongGeometry = { ...coverage, gridHash: gridHash(other.fine) };
  expect(() => preparePackedTerrainColumns(plan, wrongGeometry, active, 3, options)).toThrow(/grid identity/i);
  expect(() => preparePackedTerrainColumns(plan, coverage, active, 3, { ...options, expectedGridHash: '' })).toThrow(/grid identity/i);
});

it.each([5, 10])('bounds knot rebuilds by native quads at k=%i', k => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 5, height: 5, earthRadiusM: 6371229,
    lon0: 0, lat0: 4, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, k), target = mask(plan.fine, () => 1);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const active = Uint32Array.from({ length: 25 }, (_, i) => i);
  const frame = normalizedFixtureFrame(native, active, '2026-03-20T00:00:00Z', 12, 1);
  const prepared = preparePackedTerrainColumns(plan, coverage, active, 3, { maxBytes: 10_000_000, expectedGridHash: gridHash(plan.fine) });
  expect(prepared.byteLength).toBe(active.byteLength + (plan.fine.width + plan.fine.height) * 12 +
    (native.width + native.height) * 8 + Math.ceil(active.length / 8) + 96);
  const admitted = prepared.byteLength + prepared.workspaceBufferBytes + prepared.workspaceObjectBudgetBytes + prepared.outputBufferBytes;
  expect(() => preparePackedTerrainColumns(plan, coverage, active, 3, { maxBytes: admitted - 1, expectedGridHash: gridHash(plan.fine) })).toThrow(/byte budget/);
  expect(() => preparePackedTerrainColumns(plan, coverage, active, 3, { maxBytes: admitted, expectedGridHash: gridHash(plan.fine) })).not.toThrow();
  const count = coverage.offsets[coverage.blockIds.length]!;
  const sort = vi.spyOn(Float64Array.prototype, 'sort');
  try {
    prepared.derive(frame, { elevationM: new Float32Array(count).fill(100), valid: new Uint8Array(count).fill(1) }, day, { daylightOnly: false });
    expect(sort.mock.calls.length).toBeLessThanOrEqual(native.width * native.height);
  } finally {
    sort.mockRestore();
  }
});

it('admits a large native frame and small output under a bounded donor-workspace budget', () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 256, height: 256, earthRadiusM: 6371229,
    lon0: -1, lat0: 1, dx: 0.001, dy: -0.001, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 2), target = mask(plan.fine, index => index === 0 ? 1 : 0);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const active = Uint32Array.from({ length: native.width * native.height }, (_, index) => index);
  const prepared = preparePackedTerrainColumns(plan, coverage, active, 25, { maxBytes: 1024 * 1024, expectedGridHash: gridHash(plan.fine) });
  expect(prepared.workspaceBufferBytes).toBeLessThan(32 * 1024);
});

it('groups native edges without requiring a missing diagonal donor', () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 3, height: 3, earthRadiusM: 6371229,
    lon0: 0, lat0: 2, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 10), active = Uint32Array.of(0, 1, 3);
  const source = mask(native, index => active.includes(index) ? 1 : 0);
  const target = mask(plan.fine, index => {
    const x = index % plan.fine.width, y = Math.floor(index / plan.fine.width);
    return (y === 0 && x < 10) || (x === 0 && y < 10) ? 1 : 0;
  });
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const frame = normalizedFixtureFrame(native, active, '2026-03-20T00:00:00Z', 12, 1);
  const count = plan.fine.width * plan.fine.height;
  const dense = prepareTerrainColumns(source, target, active, 3).derive(frame,
    { elevationM: new Float32Array(count).fill(100), valid: new Uint8Array(count).fill(1) }, day, { daylightOnly: false });
  const packedCount = coverage.offsets[coverage.blockIds.length]!;
  const packed = preparePackedTerrainColumns(plan, coverage, active, 3, { maxBytes: 1_000_000, expectedGridHash: gridHash(plan.fine) }).derive(frame,
    { elevationM: new Float32Array(packedCount).fill(100), valid: new Uint8Array(packedCount).fill(1) }, day, { daylightOnly: false });
  expect(packed.metrics).toEqual(dense.metrics);
  for (let index = 0; index < count; index++) {
    const cell = sparseCoverageLookup(coverage, index % plan.fine.width, Math.floor(index / plan.fine.width));
    if (!cell) continue;
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      expect(packed.fields[layer].values[cell.offset]).toBe(dense.fields[layer].values[index]);
      expect(packed.fields[layer].flags[cell.offset]).toBe(dense.fields[layer].flags[index]);
    }
  }
});

it('delivers next-macrotask cancellation before a fine frame completes', async () => {
  const native: RegularLatLonGrid = { kind: 'regular-latlon', width: 11, height: 11, earthRadiusM: 6371229,
    lon0: 0, lat0: 10, dx: 1, dy: -1, wrapLongitude: false };
  const plan = planWholeDomainGrid(native, 10), target = mask(plan.fine, () => 1);
  const coverage = sparseCoverageFromDense({ ...plan.fine, gridHash: gridHash(plan.fine), output: target.output, halo: target.halo });
  const active = Uint32Array.from({ length: 121 }, (_, i) => i);
  const frame = normalizedFixtureFrame(native, active, '2026-03-20T00:00:00Z', 12, 1);
  const prepared = preparePackedTerrainColumns(plan, coverage, active, 3, { maxBytes: 10_000_000, expectedGridHash: gridHash(plan.fine) });
  const count = coverage.offsets[coverage.blockIds.length]!;
  const controller = new AbortController(), timer = setImmediate(() => controller.abort(new Error('cancel fine frame')));
  const terrain = { elevationM: new Float32Array(count).fill(100), valid: new Uint8Array(count).fill(1) };
  const sort = vi.spyOn(Float64Array.prototype, 'sort');
  try {
    const reference = prepared.derive(frame, terrain, day, { daylightOnly: false });
    const full = sort.mock.calls.length;
    sort.mockClear();
    const pending = prepared.deriveAsync(frame, terrain, day, { daylightOnly: false, signal: controller.signal,
      yieldControl: () => new Promise(resolve => setImmediate(resolve)) });
    expect(() => prepared.derive(frame, terrain, day, { daylightOnly: false })).toThrow(/already running/);
    await expect(pending).rejects.toThrow('cancel fine frame');
    expect(sort.mock.calls.length).toBe(0);
    const midframe = new AbortController(); let yields = 0;
    await expect(prepared.deriveAsync(frame, terrain, day, { daylightOnly: false, signal: midframe.signal,
      yieldControl: () => new Promise(resolve => setImmediate(() => { if (++yields === 2) midframe.abort(new Error('midframe')); resolve(); })) }))
      .rejects.toThrow('midframe');
    expect(sort.mock.calls.length).toBeGreaterThan(0);
    expect(sort.mock.calls.length).toBeLessThan(full);
    sort.mockClear();
    const deadlineAt = Date.now() + 100; let deadlineYields = 0;
    await expect(prepared.deriveAsync(frame, terrain, day, { daylightOnly: false, deadlineAt,
      yieldControl: () => new Promise(resolve => { if (++deadlineYields === 1) setImmediate(resolve); else setTimeout(resolve, 150); }) })).rejects.toThrow('deadline exceeded');
    expect(sort.mock.calls.length).toBeGreaterThan(0);
    expect(sort.mock.calls.length).toBeLessThan(full);
    expect(controller.signal.aborted).toBe(true);
    const complete = await prepared.deriveAsync(frame, terrain, day, { daylightOnly: false,
      yieldControl: () => new Promise(resolve => setImmediate(resolve)) });
    expect(complete.metrics).toEqual(reference.metrics);
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      expect(new Uint8Array(complete.fields[layer].values.buffer)).toEqual(new Uint8Array(reference.fields[layer].values.buffer));
      expect(complete.fields[layer].flags).toEqual(reference.fields[layer].flags);
    }
  } finally { clearImmediate(timer); sort.mockRestore(); }
});
