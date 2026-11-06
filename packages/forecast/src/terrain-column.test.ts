import { expect, it } from 'vitest';
import { setBit, STATUS_MASK, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PROFILE_TOP, TERRAIN_CLEARANCE_METHOD, type CoverageMask, type RegularLatLonGrid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { saturationVaporPressureHpa } from '@av/thermodynamics';
import { THERMODYNAMIC_CONSTANTS } from '@av/thermodynamics/constants';
import { deriveFrame, FRAME_BRANCH } from './frame.js';
import { prepareTerrainClearance, prepareTerrainColumns, terrainColumnCapacity, terrainColumnDaylightBufferBytes } from './refinement.js';

const grid: RegularLatLonGrid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 1, height: 1,
  lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: false };
const mask: CoverageMask = { grid, output: Uint8Array.of(1), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
const day = { intervalStart: '2026-03-20T11:00:00Z', validTime: '2026-03-20T12:00:00Z' };
const night = { intervalStart: '2026-03-19T23:00:00Z', validTime: '2026-03-20T00:00:00Z' };

function frame() {
  const value = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-03-20T00:00:00Z', 12, 1);
  value.terrainM[0] = 1000;
  value.temp2mK[0] = 293.15;
  value.surfacePressurePa[0] = 100000;
  value.specificHumidity2mKgKg[0] = 0.005;
  value.sensibleHeatFluxWm2[0] = 200;
  value.latentHeatFluxWm2[0] = 0;
  value.pressureLevelsHpa = [900, 850, 800, 750, 700];
  value.hgtM = [1500, 2000, 2500, 3000, 3500].map(h => Float32Array.of(h));
  value.tempK = [16, 13, 10, 7, 4].map(t => Float32Array.of(t + 273.15));
  value.missing.hgt = value.hgtM.map(() => Uint8Array.of(0));
  value.missing.temp = value.tempK.map(() => Uint8Array.of(0));
  return value;
}

const terrain = (height: number) => ({ elevationM: Float32Array.of(height), valid: Uint8Array.of(1) });

it('rejects removed surface-mode options instead of silently relabeling a forecast', () => {
  const input = frame();
  for (const surfaceMode of ['profile-anomaly', 'ridge-topographic', 'ridge-topographic-capped']) {
    const obsolete = { bridgeMode: 'neutral' as const, surfaceMode };
    expect(() => prepareTerrainColumns(mask, mask, input.activeIndices, 5, obsolete)).toThrow('surfaceMode');
  }
});

it('preserves native bytes for one donor at its own terrain', () => {
  const input = frame(), native = deriveFrame(input, mask, { daylightOnly: false });
  const result = prepareTerrainColumns(mask, mask, input.activeIndices, 5).derive(input, terrain(1000), day, { daylightOnly: false });
  for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
    expect(result.fields[layer].values).toEqual(native[layer]!.values);
    expect(result.fields[layer].flags).toEqual(native[layer]!.flags);
  }
});

it('resolves an analytic profile with the native surface excess', () => {
  const input = frame(), options = { daylightOnly: false, probeIndices: [0] };
  const control = prepareTerrainColumns(mask, mask, input.activeIndices, 5).derive(input, terrain(2000), day, options);
  expect(control.probes[0]!.depthM).toBeCloseTo(263.1578947, 1);
  expect(control.probes[0]!.surfacePressurePa!).toBeLessThan(input.surfacePressurePa[0]);
});

it('skips weather admission in darkness and resets donor cache for every frame', () => {
  const input = frame(), prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  input.missing.temp[1]![0] = 1;
  const dark = prepared.derive(input, terrain(1000), night);
  expect(dark.metrics.dark).toBe(1);
  expect(dark.fields['usable-lift-agl'].flags[0]).toBe(STATUS_NO_LIFT);
  const bad = prepared.derive(input, terrain(1000), day, { daylightOnly: false });
  expect(bad.metrics.missingDonor).toBe(1);
  expect(bad.fields['usable-lift-agl'].flags[0] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  input.missing.temp[1]![0] = 0;
  const good = prepared.derive(input, terrain(1000), day, { daylightOnly: false });
  expect(good.metrics.valid + good.metrics.noLift).toBe(1);
  expect(good.fields['usable-lift-agl'].values.buffer).not.toBe(dark.fields['usable-lift-agl'].values.buffer);
  input.activeIndices[0] = 1;
  expect(() => prepared.derive(input, terrain(1000), day)).toThrow(/identity/);
});

it('preserves native output and missing-pressure screening for model-level columns', () => {
  const source = frame();
  const pressurePa = source.pressureLevelsHpa!.map(p => Float32Array.of(p * 100));
  const input = { ...source, pressureLevelsHpa: undefined, pressurePa,
    missing: { ...source.missing, pressure: pressurePa.map(() => Uint8Array.of(0)) } };
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  const result = prepared.derive(input, terrain(1000), day, { daylightOnly: false });
  const native = deriveFrame(input, mask, { daylightOnly: false });
  expect(result.fields['usable-lift-agl']).toEqual(native['usable-lift-agl']);
  input.missing.pressure[1]![0] = 1;
  const missing = prepared.derive(input, terrain(1000), day, { daylightOnly: false });
  expect(missing.metrics.missingDonor).toBe(1);
});

it('enforces bridge bounds without rejecting an admitted synthetic gap', () => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  const short = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  const long = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { maximumBelowGroundExtrapolationM: 1500 });
  expect(short.derive(input, terrain(-500), day, { daylightOnly: false }).metrics.belowGroundBridgeExceeded).toBe(1);
  const admitted = long.derive(input, terrain(-500), day, { daylightOnly: false, probeIndices: [0] });
  expect(admitted.metrics.belowGroundBridge).toBe(1);
  expect(admitted.metrics.valid + admitted.metrics.noLift).toBe(1);
  expect(admitted.probes[0]!.surfacePressurePa!).toBeGreaterThan(90000);
  expect(admitted.probes[0]!.surfaceTemperatureK!).toBeGreaterThan(input.temp2mK[0]);
});

it('validates raw donors before a non-convective flux decision', () => {
  const input = frame(), prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  input.sensibleHeatFluxWm2[0] = -100;
  input.hgtM[1]![0] = 2600;
  const result = prepared.derive(input, terrain(1100), day, { daylightOnly: false });
  expect(result.metrics.invalidDonorInput).toBe(1);
  input.hgtM[1]![0] = 2000;
  input.latentHeatFluxWm2[0] = 3000;
  const latent = prepared.derive(input, terrain(1100), day, { daylightOnly: false, probeIndices: [0] });
  expect(latent.probes[0]!.branch).not.toBe('non-convective');
});

function sparseFixture(targetLon = 1.5, targetLat = 0.5) {
  const sourceGrid: RegularLatLonGrid = { ...grid, width: 4, height: 2, lat0: 1 };
  const targetGrid: RegularLatLonGrid = { ...grid, lon0: targetLon, lat0: targetLat };
  const active = Uint32Array.of(1, 2, 5, 6);
  const sourceMask: CoverageMask = { grid: sourceGrid, output: Uint8Array.of(0), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (const index of active) setBit(sourceMask.output, index);
  const targetMask: CoverageMask = { ...mask, grid: targetGrid };
  const input = normalizedFixtureFrame(sourceGrid, active, '2026-03-20T00:00:00Z', 12, 1);
  input.terrainM.set([100, 200, 300, 400]);
  input.temp2mK.fill(293.15);
  input.specificHumidity2mKgKg.fill(0.005);
  input.hgtM = [800, 1300, 1800].map(height => new Float32Array(4).fill(height));
  input.tempK = [289, 285, 280].map(temperature => new Float32Array(4).fill(temperature));
  return { input, active, sourceMask, targetMask };
}

it('maps sparse global contributors to compact slots and conserves RH at zero displacement', () => {
  const { input, active, sourceMask, targetMask } = sparseFixture();
  const prepared = prepareTerrainColumns(sourceMask, targetMask, active, 3);
  const capacity = terrainColumnCapacity(4, 1, 3, targetMask.grid, 4);
  expect(capacity.mappingBufferBytes).toBe(prepared.byteLength);
  expect(capacity.workspaceBytes).toBe(prepared.workspaceBytes);
  expect(terrainColumnCapacity(4, 1, 3, targetMask.grid).mappingBufferBytes).toBeGreaterThanOrEqual(prepared.byteLength);
  expect(prepared.workspaceBytes).toBe(prepared.workspaceBufferBytes + prepared.workspaceObjectBudgetBytes);
  expect(prepared.workspaceBufferBytes).toBe(4 * (3 * 16 + 53) + 4 * (3 + 3) * 58 + 4 + 88);
  const result = prepared.derive(input, terrain(250), day, { daylightOnly: false, probeIndices: [0] });
  expect(result.daylightBufferBytes).toBe(0);
  const probe = result.probes[0]!;
  expect(probe.donorIndices).toEqual([1, 2, 5, 6]);
  expect(probe.donorWeights).toEqual([0.25, 0.25, 0.25, 0.25]);
  expect(probe.referenceTerrainM).toBe(250);
  const relativeHumidity = (q: number, p: number, t: number) => {
    const r = q / (1 - q);
    return p / 100 * r / (THERMODYNAMIC_CONSTANTS.waterDryAirMolarMassRatio + r) / saturationVaporPressureHpa(t - 273.15);
  };
  expect(relativeHumidity(probe.humidityKgKg!, probe.surfacePressurePa!, probe.surfaceTemperatureK!))
    .toBeCloseTo(relativeHumidity(input.specificHumidity2mKgKg[0]!, input.surfacePressurePa[0]!, input.temp2mK[0]!), 10);
  expect(probe.surfacePressurePa).toBe(input.surfacePressurePa[0]);
  const low = prepared.derive(input, terrain(200), day, { daylightOnly: false, probeIndices: [0] });
  const high = prepared.derive(input, terrain(300), day, { daylightOnly: false, probeIndices: [0] });
  expect(low.probes[0]!.surfacePressurePa!).toBeGreaterThan(probe.surfacePressurePa!);
  expect(high.probes[0]!.surfacePressurePa!).toBeLessThan(probe.surfacePressurePa!);
  expect(low.fields['usable-lift-msl'].values.buffer).not.toBe(result.fields['usable-lift-msl'].values.buffer);
  expect(low.fields['usable-lift-agl'].values.buffer).not.toBe(low.fields['usable-lift-msl'].values.buffer);
  expect(low.fields['usable-lift-msl'].values.buffer).not.toBe(input.terrainM.buffer);
  active[0] = 0;
  expect(() => prepared.derive(input, terrain(250), day)).toThrow(/identity/);
});

it('ignores zero-weight missing donors but rejects a missing positive-weight donor', () => {
  const { input, active, sourceMask } = sparseFixture();
  input.missing.temp[0]![1] = 1;
  const node: CoverageMask = { ...mask, grid: { ...grid, lon0: 1, lat0: 1 } };
  const prepared = prepareTerrainColumns(sourceMask, node, active, 3);
  const result = prepared.derive(input, terrain(100), day, { daylightOnly: false, probeIndices: [0] });
  expect(result.probes[0]!.donorIndices).toEqual([1]);
  expect(result.metrics.valid + result.metrics.noLift).toBe(1);
  const middle = sparseFixture();
  middle.input.missing.temp[0]![1] = 1;
  const missing = prepareTerrainColumns(middle.sourceMask, middle.targetMask, middle.active, 3)
    .derive(middle.input, terrain(250), day, { daylightOnly: false });
  expect(missing.metrics.missingDonor).toBe(1);
});

it('does not access weather for dark supported cells', () => {
  const input = frame(), prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  Object.defineProperty(input, 'tempK', { get() { throw new Error('weather accessed'); } });
  const result = prepared.derive(input, terrain(1000), night);
  expect(result.metrics.dark).toBe(1);
  expect(result.fields['usable-lift-msl'].values[0]).toBe(1000);
  expect(prepared.derive(input, { elevationM: Float32Array.of(0), valid: Uint8Array.of(0) }, night).metrics.invalidDem).toBe(1);
  const sparse = sparseFixture();
  sparse.sourceMask.output[0] = 0;
  setBit(sparse.sourceMask.output, 1);
  const noGeometry = prepareTerrainColumns(sparse.sourceMask, sparse.targetMask, Uint32Array.of(1), 3);
  const sparseFrame = normalizedFixtureFrame(sparse.input.grid, Uint32Array.of(1), sparse.input.cycle, 12, 1);
  Object.defineProperty(sparseFrame, 'tempK', { get() { throw new Error('weather accessed'); } });
  expect(noGeometry.derive(sparseFrame, terrain(250), night).metrics.missingDonor).toBe(1);
});

it('preserves dry-neutral profile-anomaly crossing across elevations', () => {
  const input = frame();
  input.tempK = [1500, 2000, 2500, 3000, 3500].map(h => Float32Array.of(273.15 + 19 - 0.0098 * (Math.min(h, 3000) - 1000)));
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  const options = { daylightOnly: false, probeIndices: [0] };
  const low = prepared.derive(input, terrain(1500), day, options).probes[0]!;
  const high = prepared.derive(input, terrain(2000), day, options).probes[0]!;
  expect(low.depthM! + 1500).toBeCloseTo(3102.040816, 1);
  expect(high.depthM! + 2000).toBeCloseTo(3102.040816, 1);
});

it.each(['isobaric', 'model-levels'] as const)('matches frozen native golden bytes in %s identity', coordinate => {
  const source = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-11-03T12:00:00Z', 21, 1);
  const pressures = source.pressureLevelsHpa!.map(p => Float32Array.of(p * 100));
  const input = coordinate === 'isobaric' ? source : { ...source, pressureLevelsHpa: undefined, pressurePa: pressures,
    missing: { ...source.missing, pressure: pressures.map(() => Uint8Array.of(0)) } };
  const result = prepareTerrainColumns(mask, mask, input.activeIndices, 3)
    .derive(input, terrain(100), day, { daylightOnly: false });
  expect(result.fields['usable-lift-msl'].values).toEqual(Float32Array.of(1253.84619140625));
  expect(result.fields['usable-lift-agl'].values).toEqual(Float32Array.of(1153.84619140625));
  expect(result.fields['usable-lift-msl'].flags).toEqual(Uint8Array.of(4));
  expect(result.fields['usable-lift-agl'].flags).toEqual(Uint8Array.of(4));
});

it('charges regular and projected daylight buffers for the actual timestamp count', () => {
  const regular = { ...grid, width: 8, height: 7 };
  const projected = { kind: 'lambert-conformal' as const, earthRadiusM: 6371229, width: 8, height: 7,
    centralMeridianDeg: 10, latitudeOfOriginDeg: 40, standardParallel1Deg: 38, standardParallel2Deg: 42,
    x0M: 0, y0M: 0, dxM: 1000, dyM: -1000, wrapLongitude: false as const };
  expect(terrainColumnDaylightBufferBytes(regular, 0)).toBe(0);
  expect(terrainColumnDaylightBufferBytes(regular, 1)).toBe(16 * 7 + 8 * 8 + 16);
  expect(terrainColumnDaylightBufferBytes(regular, 3)).toBe(16 * 7 + 24 * 8 + 48);
  expect(terrainColumnDaylightBufferBytes(projected, 0)).toBe(0);
  expect(terrainColumnDaylightBufferBytes(projected, 1)).toBe(24);
  expect(terrainColumnDaylightBufferBytes(projected, 3)).toBe(72);
  const input = frame(), prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5);
  expect(prepared.daylightBufferBytes).toBe(88);
  expect(prepared.derive(input, terrain(1000), day).daylightBufferBytes).toBe(88);
  expect(prepared.derive(input, terrain(1000), { intervalStart: day.validTime, validTime: day.validTime }).daylightBufferBytes).toBe(40);
  expect(prepared.derive(input, terrain(1000), day, { daylightOnly: false }).daylightBufferBytes).toBe(0);
  const projectedGrid = { ...projected, width: 1, height: 1 };
  const projectedMask = { ...mask, grid: projectedGrid };
  const projectedInput = normalizedFixtureFrame(projectedGrid, Uint32Array.of(0), '2026-03-20T00:00:00Z', 12, 1);
  const projectedPrepared = prepareTerrainColumns(projectedMask, projectedMask, projectedInput.activeIndices, 3);
  expect(projectedPrepared.daylightBufferBytes).toBe(72);
  expect(projectedPrepared.derive(projectedInput, terrain(100), day).daylightBufferBytes).toBe(72);
  expect(projectedPrepared.derive(projectedInput, terrain(100), { intervalStart: day.validTime, validTime: day.validTime }).daylightBufferBytes).toBe(24);
});

it.each(['isobaric', 'model-levels'] as const)('matches pre-extraction branch goldens in %s at native terrain', coordinate => {
  const cases = [
    { name: 'stable', temperatures: [17, 12, 7], msl: '0000c842', agl: '00000000', flag: 1, branch: 4 },
    { name: 'neutral', temperatures: [15.1, 10.2, 5.3], msl: '0000c844', agl: '0080bb44', flag: 8, branch: 3 },
    { name: 'crossing', temperatures: [13, 9, 8], msl: '14bb9c44', agl: '143b9044', flag: 4, branch: 2 },
    { name: 'profile-top', temperatures: [10, 0, -10], msl: '0000c844', agl: '0080bb44', flag: 8, branch: 3 },
    { name: 'missing', temperatures: [13, 9, 8], msl: '0000c07f', agl: '0000c07f', flag: 2, branch: 0 }
  ];
  for (const item of cases) {
    const source = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
    source.tempK.forEach((level, i) => { level[0] = 273.15 + item.temperatures[i]!; });
    if (item.name === 'missing') source.missing.temp[1]![0] = 1;
    const pressure = source.pressureLevelsHpa!.map(value => Float32Array.of(value * 100));
    const input = coordinate === 'isobaric' ? source : { ...source, pressureLevelsHpa: undefined, pressurePa: pressure,
      missing: { ...source.missing, pressure: pressure.map(() => Uint8Array.of(0)) } };
    const diagnostics = { ceilingMslM: new Float32Array(1), buoyancyM2S3: new Float32Array(1), branch: new Uint8Array(1) };
    const native = deriveFrame(input, mask, { daylightOnly: false, diagnostics });
    expect(diagnostics.branch[0], item.name).toBe(item.branch);
      const refined = prepareTerrainColumns(mask, mask, input.activeIndices, 3)
        .derive(input, terrain(100), day, { daylightOnly: false });
      for (const [layer, expected] of [['usable-lift-msl', item.msl], ['usable-lift-agl', item.agl]] as const) {
        expect(Buffer.from(native[layer]!.values.buffer).toString('hex'), item.name).toBe(expected);
        expect(Buffer.from(refined.fields[layer].values.buffer).toString('hex'), item.name).toBe(expected);
        expect(native[layer]!.flags[0], item.name).toBe(item.flag);
        expect(refined.fields[layer].flags[0], item.name).toBe(item.flag);
      }
  }
});

function clearance(height: number, agl = 400, flags = STATUS_VALID | SUPPORT_PROFILE_TOP) {
  return { methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: day.validTime, grid: mask.grid, fields: {
    'usable-lift-msl': { values: Float32Array.of(height + agl), flags: Uint8Array.of(flags) },
    'usable-lift-agl': { values: Float32Array.of(agl), flags: Uint8Array.of(flags) }
  } };
}

it('uses both original surface anomalies while excluding an unsupported high donor at fine ground', () => {
  const { input, active, sourceMask } = sparseFixture(1.5, 1);
  input.terrainM.set([800, 2800, 800, 2800]);
  input.temp2mK.fill(293.15);
  input.pressureLevelsHpa = [950, 900, 850, 800, 750, 700];
  input.hgtM = [0, 1, 2, 3, 4, 5].map(i => Float32Array.of(1300 + 500 * i, 3300 + 500 * i, 1300 + 500 * i, 3300 + 500 * i));
  input.tempK = [0, 1, 2, 3, 4, 5].map(i => Float32Array.of(285 - 3 * i, 280 - 3 * i, 285 - 3 * i, 280 - 3 * i));
  input.missing.hgt = input.hgtM.map(() => new Uint8Array(4));
  input.missing.temp = input.tempK.map(() => new Uint8Array(4));
  const targetMask = { ...mask, grid: { ...grid, lon0: 1.5, lat0: 1 } };
  const prepared = prepareTerrainColumns(sourceMask, targetMask, active, 6, { clearanceFallback: 'unsupported' });
  const result = prepared.derive(input, terrain(1000), day, { daylightOnly: false, probeIndices: [0] });
  const probe = result.probes[0]!;
  expect(probe.referenceTerrainM).toBe(1800);
  expect(probe.donorWeights).toEqual([0.5, 0.5]);
  expect(probe.donorGroundWeights).toEqual([1, 0]);
  expect(probe.donorGroundEnvironmentK[0]).toBeCloseTo(288, 10);
  expect(probe.donorGroundEnvironmentK[1]).toBeCloseTo(283, 10);
  expect(probe.groundEnvironmentK).toBeCloseTo(286.8, 10);
  expect(probe.surfaceExcessK).toBeCloseTo(input.temp2mK[0]! - 285.5, 10);
  expect(probe.surfaceTemperatureK).toBeCloseTo(probe.groundEnvironmentK! + probe.surfaceExcessK!, 10);
  expect(result.metrics.column).toBe(1);
  expect(result.fields['usable-lift-msl'].values[0]).toBeCloseTo(1000 + result.fields['usable-lift-agl'].values[0]!, 3);
  const offsetMask = { ...mask, grid: { ...grid, lon0: 1.25, lat0: 1 } };
  const offset = prepareTerrainColumns(sourceMask, offsetMask, active, 6)
    .derive(input, terrain(1000), day, { daylightOnly: false, probeIndices: [0] });
  expect(offset.probes[0]!.referenceTerrainM).toBe(1300);
  expect(offset.probes[0]!.donorWeights).toEqual([0.75, 0.25]);
  expect(offset.probes[0]!.donorGroundWeights).toEqual([1, 0]);
  expect(offset.metrics.column).toBe(1);
  const invalid = { ...input, missing: { ...input.missing, temp: input.missing.temp.map(a => a.slice()) } };
  invalid.missing.temp[1]![1] = 1;
  expect(prepared.derive(invalid, terrain(1000), day, { daylightOnly: false }).metrics.missingDonor).toBe(1);
});

it('matches the original anomaly formula for equal donor terrain', () => {
  const { input, active, sourceMask, targetMask } = sparseFixture();
  input.terrainM.fill(250);
  input.temp2mK.set([290, 291, 292, 293]);
  const result = prepareTerrainColumns(sourceMask, targetMask, active, 3)
    .derive(input, terrain(300), day, { daylightOnly: false, probeIndices: [0] });
  const p = result.probes[0]!;
  const meanSurface = (290 + 291 + 292 + 293) / 4;
  const meanEnvironment = p.donorGroundEnvironmentK.reduce((sum, value) => sum + value / 4, 0);
  expect(p.surfaceTemperatureK).toBeCloseTo(p.groundEnvironmentK! + meanSurface - meanEnvironment, 10);
  expect(p.donorGroundWeights).toEqual(p.donorWeights);
});

it.each([1000, 1500] as const)('uses fallback only beyond the %i m bridge endpoint', bound => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5,
    { maximumBelowGroundExtrapolationM: bound, clearanceFallback: 'unsupported' });
  const sample = (depth: number) => {
    const height = Math.fround(1000 - depth);
    return prepared.derive(input, terrain(height), day, { daylightOnly: false, probeIndices: [0], clearance: clearance(height) });
  };
  const epsilon = 0.01;
  expect(sample(bound - epsilon).probes[0]!.provenance).toBe('column');
  expect(sample(bound).probes[0]!.provenance).toBe('column');
  for (const d of [bound + epsilon]) {
    const result = sample(d);
    expect(result.probes[0]!.provenance).toBe('clearance');
    expect(result.probes[0]!.surfaceTemperatureK).toBeNull();
    expect(result.probes[0]!.surfacePressurePa).toBeNull();
    expect(result.probes[0]!.humidityKgKg).toBeNull();
    expect(result.probes[0]!.branch).toBeNull();
    expect(result.probes[0]!.depthM).toBeNull();
    expect(result.fields['usable-lift-agl'].values[0]).toBe(400);
  }
  expect(sample(bound + epsilon).metrics.filledBelowGroundBridgeExceeded).toBe(1);
});

it('uses empirical clearance beyond the bound without inventing a local surface state', () => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  input.temp2mK[0] = 273.15 + 59;
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { clearanceFallback: 'unsupported' });
  for (const height of [100, 0]) {
    const result = prepared.derive(input, terrain(height), day,
      { daylightOnly: false, probeIndices: [0], clearance: clearance(height) });
    expect(result.metrics.solverRejected).toBe(1);
    expect(result.metrics.clearance).toBe(0);
    expect(result.probes[0]!.reason).toBe('solverRejected');
    expect(result.fields['usable-lift-agl'].flags[0]! & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  }
  const result = prepared.derive(input, terrain(-1), day,
    { daylightOnly: false, probeIndices: [0], clearance: clearance(-1) });
  expect(result.fields['usable-lift-agl'].values[0]).toBe(400);
  expect(result.metrics.filledBelowGroundBridgeExceeded).toBe(1);
  expect(result.metrics.belowGroundBridgeExceededObserved).toBe(1);
  expect(result.metrics.solverRejected).toBe(0);
  expect(result.probes[0]).toMatchObject({ provenance: 'clearance', reason: 'belowGroundBridgeExceeded',
    surfaceTemperatureK: null, surfacePressurePa: null, humidityKgKg: null, branch: null, depthM: null });
});

it.each([
  { lon: 1.5, humidity: [0.99, 0.99], expected: 0.99 },
  { lon: 1.25, humidity: [0.4, 0.9], expected: 0.525 }
])('interpolates donor RH across different temperatures at longitude $lon', ({ lon, humidity, expected }) => {
  const { input, active, sourceMask, targetMask } = sparseFixture(lon, 1);
  input.terrainM.fill(1000);
  input.temp2mK.set([273.15, 293.15, 273.15, 293.15]);
  input.surfacePressurePa.fill(100000);
  input.sensibleHeatFluxWm2.fill(200);
  input.latentHeatFluxWm2.fill(0);
  input.pressureLevelsHpa = [900, 850, 800, 750, 700];
  input.hgtM = [1500, 2000, 2500, 3000, 3500].map(h => new Float32Array(4).fill(h));
  input.tempK = [-4, -7, -10, -13, -16].map(t => Float32Array.of(t + 273.15, t + 293.15, t + 273.15, t + 293.15));
  input.missing.hgt = input.hgtM.map(() => new Uint8Array(4));
  input.missing.temp = input.tempK.map(() => new Uint8Array(4));
  const epsilon = THERMODYNAMIC_CONSTANTS.waterDryAirMolarMassRatio;
  for (let i = 0; i < active.length; i++) {
    const vapor = humidity[i % 2]! * saturationVaporPressureHpa(input.temp2mK[i]! - 273.15);
    const r = epsilon * vapor / (1000 - vapor);
    input.specificHumidity2mKgKg[i] = r / (1 + r);
  }
  const native = deriveFrame(input, sourceMask, { daylightOnly: false });
  for (const index of active) expect(native['usable-lift-agl']!.flags[index]! & STATUS_MASK).toBe(STATUS_VALID);
  const prepared = prepareTerrainColumns(sourceMask, targetMask, active, 5, { clearanceFallback: 'unsupported' });
  const column = prepared.derive(input, terrain(1100), day, { daylightOnly: false, probeIndices: [0] });
  expect(column.metrics.invalidSurfaceState).toBe(0);
  expect(column.metrics.column).toBe(1);
  const probe = column.probes[0]!, q = probe.humidityKgKg!, r = q / (1 - q);
  const rh = probe.surfacePressurePa! / 100 * r / (epsilon + r) / saturationVaporPressureHpa(probe.surfaceTemperatureK! - 273.15);
  expect(rh).toBeCloseTo(expected, 6);
  const fallback = prepared.derive(input, terrain(-1), day, { daylightOnly: false,
    clearance: { ...clearance(-1), grid: targetMask.grid } });
  expect(fallback.metrics.clearance).toBe(1);
  expect(fallback.fields['usable-lift-agl'].values[0]).toBe(400);
});

it('rejects corrupt donor humidity before using column or clearance fields', () => {
  const { input, active, sourceMask, targetMask } = sparseFixture();
  input.specificHumidity2mKgKg[0] = 0.1;
  const prepared = prepareTerrainColumns(sourceMask, targetMask, active, 3, { clearanceFallback: 'unsupported' });
  for (const height of [-500, -700]) {
    const result = prepared.derive(input, terrain(height), day, { daylightOnly: false, probeIndices: [0],
      clearance: { ...clearance(height), grid: targetMask.grid } });
    expect(result.metrics.invalidDonorInput).toBe(1);
    expect(result.metrics.clearance).toBe(0);
    expect(result.fields['usable-lift-agl'].flags[0]! & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  }
});

it('does not fill missing raw surface fields or interior observations', () => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { clearanceFallback: 'unsupported' });
  const options = { daylightOnly: false, clearance: clearance(-1) };
  for (const missing of [input.missing.terrain, input.missing.surfacePressure, input.missing.temp2m,
    input.missing.humidity2m, input.missing.sensibleHeatFlux, input.missing.latentHeatFlux, input.missing.hgt[1]!, input.missing.temp[1]!]) {
    missing[0] = 1;
    const result = prepared.derive(input, terrain(-1), day, options);
    expect(result.metrics.missingDonor).toBe(1);
    expect(result.metrics.clearance).toBe(0);
    missing[0] = 0;
  }
  input.tempK[1]![0] = NaN;
  const interiorNaN = prepared.derive(input, terrain(-1), day, options);
  expect(interiorNaN.metrics.missingDonor).toBe(1);
  expect(interiorNaN.metrics.clearance).toBe(0);
});

it('validates fallback fields without masking weather or terrain failures', () => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { clearanceFallback: 'unsupported' });
  const height = -1, fallback = clearance(height), options = { daylightOnly: false, probeIndices: [0], clearance: fallback };
  const before = fallback.fields['usable-lift-agl'].values.slice();
  const filled = prepared.derive(input, terrain(height), day, options);
  expect(filled.probes[0]!.surfaceTemperatureK).toBeNull();
  expect(filled.metrics.filledBelowGroundBridgeExceeded).toBe(1);
  expect(filled.metrics.belowGroundBridgeExceededObserved).toBe(1);
  expect(filled.metrics.belowGroundBridgeExceeded).toBe(0);
  const frozenLegacy = { ...fallback, methodHash: 'frozen-legacy-source-hash' };
  expect(prepared.derive(input, terrain(height), day, { ...options, clearance: frozenLegacy }).fields).toEqual(filled.fields);
  expect(fallback.fields['usable-lift-agl'].values).toEqual(before);
  expect(filled.fields['usable-lift-agl'].values.buffer).not.toBe(fallback.fields['usable-lift-agl'].values.buffer);
  input.missing.temp[1]![0] = 1;
  expect(prepared.derive(input, terrain(height), day, options).metrics.missingDonor).toBe(1);
  input.missing.temp[1]![0] = 0;
  expect(prepared.derive(input, { elevationM: Float32Array.of(height), valid: Uint8Array.of(0) }, day, options).metrics.invalidDem).toBe(1);
  expect(prepared.derive(input, terrain(3500), day, { ...options, clearance: clearance(3500) }).metrics.unsupportedHeight).toBe(1);
  expect(() => prepared.derive(input, terrain(height), day, { ...options, clearance: { ...fallback, validTime: night.validTime } })).toThrow(/clearance/);
  expect(() => prepared.derive(input, terrain(height), day, { ...options, clearance: { ...fallback, grid: { ...grid, lon0: 2 } } })).toThrow(/clearance/);
  expect(() => prepared.derive(input, terrain(height), day, { ...options, clearance: { ...fallback, methodId: 'unrelated-method' } })).toThrow(/clearance/);
  expect(() => prepared.derive(input, terrain(height), day, { ...options, clearance: { ...fallback, methodId: undefined as unknown as string } })).toThrow(/clearance/);
  fallback.fields['usable-lift-agl'].values[0] = NaN;
  expect(prepared.derive(input, terrain(height), day, options).metrics.belowGroundBridgeExceeded).toBe(1);
  fallback.fields['usable-lift-agl'].values[0] = 400;
  fallback.fields['usable-lift-agl'].flags[0] = 128;
  expect(prepared.derive(input, terrain(height), day, options).metrics.belowGroundBridgeExceeded).toBe(1);
  expect(prepared.derive(input, terrain(200), day, options).metrics.column).toBe(1);
  const without = prepared.derive(input, terrain(100), day, { daylightOnly: false });
  const invalidFallback = prepared.derive(input, terrain(100), day, options);
  expect(invalidFallback.fields).toEqual(without.fields);
  const stable = clearance(height, 0, STATUS_NO_LIFT);
  expect(prepared.derive(input, terrain(height), day, { ...options, clearance: stable }).fields['usable-lift-agl'].flags[0]).toBe(STATUS_NO_LIFT);
});

it.each(['unsupported', 'none'] as const)('preserves a valid column with nonfinite clearance in %s mode', fallbackMode => {
  const input = frame();
  input.surfacePressurePa[0] = 90000;
  input.pressureLevelsHpa = [850, 800, 750, 700, 650];
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { clearanceFallback: fallbackMode });
  for (const height of [100, 1000]) {
    const expected = prepared.derive(input, terrain(height), day, { daylightOnly: false });
    for (const value of [NaN, Infinity, -Infinity]) {
      const fallback = clearance(height);
      fallback.fields['usable-lift-agl'].values[0] = value;
      const actual = prepared.derive(input, terrain(height), day, { daylightOnly: false, clearance: fallback, probeIndices: [0] });
      expect(actual.fields).toEqual(expected.fields);
      expect(Number.isFinite(actual.fields['usable-lift-agl'].values[0])).toBe(true);
      expect(actual.probes[0]!.provenance).toBe('column');
      expect(actual.metrics.column).toBe(1);
    }
  }
  const fallback = clearance(-1);
  fallback.fields['usable-lift-agl'].values[0] = NaN;
  const unavailable = prepared.derive(input, terrain(-1), day, { daylightOnly: false, clearance: fallback });
  expect(unavailable.fields['usable-lift-agl'].flags[0]! & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  expect(unavailable.metrics.belowGroundBridgeExceeded).toBe(1);
});

it.each(['isobaric', 'model-levels'] as const)('matches dense clearance fallback for %s donors and boundary targets', coordinate => {
  const { input: source, active, sourceMask } = sparseFixture();
  source.terrainM.fill(1200);
  source.pressureLevelsHpa = [900, 850, 800];
  source.hgtM = [1700, 2200, 2700].map(height => new Float32Array(4).fill(height));
  source.tempK = [286, 282, 278].map(temperature => new Float32Array(4).fill(temperature));
  const pressure = source.pressureLevelsHpa.map(value => new Float32Array(4).fill(value * 100));
  const input = coordinate === 'isobaric' ? source : { ...source, pressureLevelsHpa: undefined, pressurePa: pressure,
    missing: { ...source.missing, pressure: pressure.map(() => new Uint8Array(4)) } };
  const targetGrid = { ...grid, width: 3, height: 3, lon0: 1, lat0: 1, dx: 0.5, dy: -0.5 };
  const targetMask: CoverageMask = { grid: targetGrid, output: Uint8Array.of(255, 1), halo: Uint8Array.of(0, 0), tiles: Uint8Array.of(1), maxZoom: 0 };
  const dem = { elevationM: Float32Array.of(200, 199, -50, 1200, 199, 2700, 199, 200, 0), valid: new Uint8Array(9).fill(1) };
  const diagnostics = { ceilingMslM: new Float32Array(8), buoyancyM2S3: new Float32Array(8), branch: new Uint8Array(8) };
  const flags = deriveFrame(input, sourceMask, { daylightOnly: false, diagnostics })['usable-lift-agl']!.flags;
  const nativeClearance = { validTime: day.validTime, grid: sourceMask.grid, diagnostics, flags };
  const prepared = prepareTerrainColumns(sourceMask, targetMask, active, 3, { clearanceFallback: 'unsupported' });
  const dense = prepareTerrainClearance(sourceMask, targetMask);
  const compare = () => {
    const fields = dense.derive(diagnostics, flags, dem, day, false);
    const reference = prepared.derive(input, dem, day, { daylightOnly: false, clearance: {
      methodId: TERRAIN_CLEARANCE_METHOD.id, validTime: day.validTime, grid: targetGrid, fields
    }, probeIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
    const lazy = prepared.derive(input, dem, day, { daylightOnly: false, nativeClearance, probeIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8] });
    expect(lazy.fields).toEqual(reference.fields);
    expect(lazy.metrics).toEqual(reference.metrics);
    expect(lazy.probes).toEqual(reference.probes);
    return lazy;
  };
  const convective = compare();
  expect(convective.metrics.clearance).toBeGreaterThan(0);
  expect(convective.metrics.column).toBeGreaterThan(0);
  expect(convective.metrics.unsupportedHeight).toBe(1);
  diagnostics.branch[2] = FRAME_BRANCH.nonConvective;
  diagnostics.ceilingMslM[2] = 1200;
  diagnostics.buoyancyM2S3[2] = 0;
  flags[2] = STATUS_NO_LIFT;
  const mixed = compare();
  expect(mixed.probes[1]!.reason).toBe('belowGroundBridgeExceeded');
  expect(mixed.probes[2]!.provenance).toBe('clearance');
  expect(mixed.probes[4]!.provenance).toBeNull();
  diagnostics.branch[2] = FRAME_BRANCH.unavailable;
  diagnostics.ceilingMslM[2] = NaN;
  flags[2] = STATUS_UNAVAILABLE;
  const missing = compare();
  expect(missing.probes[6]!.provenance).toBe('clearance');
  expect(missing.probes[1]!.provenance).toBeNull();
  for (const index of active) {
    diagnostics.branch[index] = FRAME_BRANCH.surfaceStable;
    diagnostics.ceilingMslM[index] = 1200;
    diagnostics.buoyancyM2S3[index] = 0;
    flags[index] = STATUS_NO_LIFT | SUPPORT_PROFILE_TOP;
  }
  const stable = compare();
  expect(stable.fields['usable-lift-agl'].flags[1]).toBe(STATUS_NO_LIFT | SUPPORT_PROFILE_TOP);
  expect(stable.fields['usable-lift-agl'].values[1]).toBe(0);
});

it('validates native clearance identity and reads diagnostics only on eligible fallback', () => {
  const input = frame(), diagnostics = { ceilingMslM: Float32Array.of(3000), buoyancyM2S3: Float32Array.of(1),
    branch: new Proxy(Uint8Array.of(FRAME_BRANCH.profileTop), { get(target, key) {
      if (key === '0') throw new Error('diagnostics accessed');
      return Reflect.get(target, key, target);
    } }) };
  const nativeClearance = { validTime: day.validTime, grid, diagnostics, flags: Uint8Array.of(STATUS_VALID) };
  const prepared = prepareTerrainColumns(mask, mask, input.activeIndices, 5, { clearanceFallback: 'unsupported' });
  expect(prepared.derive(input, terrain(1000), day, { daylightOnly: false, nativeClearance }).metrics.column).toBe(1);
  expect(prepared.derive({ ...input, validAt: night.validTime }, terrain(-1), night,
    { nativeClearance: { ...nativeClearance, validTime: night.validTime }, daylightOnly: true }).metrics.dark).toBe(1);
  expect(prepareTerrainColumns(mask, mask, input.activeIndices, 5).derive(input, terrain(-1), day,
    { daylightOnly: false, nativeClearance }).metrics.belowGroundBridgeExceeded).toBe(1);
  expect(() => prepared.derive(input, terrain(-1), day, { daylightOnly: false, nativeClearance })).toThrow('diagnostics accessed');
  expect(() => prepared.derive(input, terrain(-1), day, { daylightOnly: false,
    nativeClearance: { ...nativeClearance, validTime: night.validTime } })).toThrow(/native terrain clearance/);
  expect(() => prepared.derive(input, terrain(-1), day, { daylightOnly: false,
    nativeClearance: { ...nativeClearance, grid: { ...grid, lon0: 1 } } })).toThrow(/native terrain clearance/);
  expect(() => prepared.derive(input, terrain(-1), day, { daylightOnly: false, nativeClearance, clearance: clearance(-1) })).toThrow(/one terrain clearance/);
});
