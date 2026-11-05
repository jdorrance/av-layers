import { expect, it } from 'vitest';
import { CLOUD_SUPPORT_MASK, LAYER_IDS, STATUS_MASK, STATUS_NO_LIFT, STATUS_UNAVAILABLE, STATUS_VALID,
  setBit, sparseCoverageFromDense, sparseCoverageLookup, type CoverageMask, type Grid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { deriveFrame } from './frame.js';
import { prepareNativeProfiles } from './native-fields.js';
import { readProfileRecord } from './profile-pack.js';
import type { AuxField } from './inputs.js';

function fixture(hour = 12) {
  const grid: Grid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 32, height: 2,
    lon0: 0, lat0: 1, dx: 0.1, dy: -0.1, wrapLongitude: false };
  const active = Uint32Array.of(0, 16, 32, 48), frame = normalizedFixtureFrame(grid, active, '2026-06-21T00:00:00Z', hour, 1);
  const values = (value: number) => new Float32Array(active.length).fill(value);
  const aux = (value: number): AuxField => ({ values: values(value), missing: new Uint8Array(active.length) });
  const mask: CoverageMask = { grid, output: new Uint8Array(8), halo: new Uint8Array(8), tiles: Uint8Array.of(1), maxZoom: 0 };
  for (const index of active) setBit(mask.output, index);
  const coverage = sparseCoverageFromDense({ ...grid, gridHash: 'a'.repeat(64), output: mask.output, halo: mask.halo });
  frame.temp2mK.fill(298.15);
  frame.hgtM = [200, 600, 1200, 1800].map(values);
  frame.tempK = [23, 20, 15, 12].map(t => values(t + 273.15));
  frame.pressureLevelsHpa = [980, 940, 880, 820];
  frame.missing.hgt = frame.hgtM.map(() => new Uint8Array(active.length));
  frame.missing.temp = frame.tempK.map(() => new Uint8Array(active.length));
  frame.auxSurface = { mslpPa: aux(101325), u10mMps: aux(3), v10mMps: aux(-4), gust10mMps: aux(8),
    pblHeightM: aux(800), capeJkg: aux(250), cloudTotalPct: aux(60), cloudLowPct: aux(25) };
  frame.auxLevels = { rhPercent: [60, 70, 90, 90].map(aux), uWindMps: [4, 5, 6, 7].map(aux), vWindMps: [-1, -2, -3, -4].map(aux) };
  return { frame, mask, coverage };
}

it('emits synoptic fields, LCL and PBL winds through darkness while skipping convection', () => {
  const { frame, mask, coverage } = fixture(3);
  const fields = deriveFrame(frame, mask, { layers: LAYER_IDS, nativeCoverage: coverage });
  const slot = sparseCoverageLookup(coverage, 0, 0)!.offset;
  for (const layer of ['sfc-temp-c', 'sfc-dewpoint-c', 'surface-lcl-msl', 'cape-jkg', 'cloud-cover-total', 'bl-mean-wind-u', 'bl-mean-wind-v'] as const) {
    expect(fields[layer]!.flags[slot] & STATUS_MASK).toBe(STATUS_VALID);
    expect(Number.isFinite(fields[layer]!.values[slot])).toBe(true);
  }
  expect(fields['thermal-velocity']!.values[slot]).toBe(0);
  expect(fields['thermal-top-msl']!.values[slot]).toBe(100);
  expect(fields['thermal-velocity']!.flags[slot] & CLOUD_SUPPORT_MASK).toBe(0);
  expect(fields['usable-lift-agl']!.flags[0]).toBe(STATUS_NO_LIFT);
  expect(fields['precip-rate']!.flags[0]).toBe(STATUS_VALID);
  expect(fields['precip-rate']!.values[0]).toBe(3);
});

it('keeps positive thermal velocity below the map sink threshold', () => {
  const { frame, mask, coverage } = fixture();
  frame.sensibleHeatFluxWm2.fill(1); frame.latentHeatFluxWm2.fill(0);
  const fields = deriveFrame(frame, mask, { layers: LAYER_IDS, nativeCoverage: coverage });
  const slot = sparseCoverageLookup(coverage, 0, 0)!.offset;
  expect(fields['thermal-velocity']!.flags[slot] & STATUS_MASK).toBe(STATUS_VALID);
  expect(fields['thermal-velocity']!.values[slot]).toBeGreaterThan(0);
  expect(fields['thermal-velocity']!.values[slot]).toBeLessThan(1.2);
  expect(fields['thermal-top-msl']!.values[slot]).toBeGreaterThan(frame.terrainM[0]!);
  expect(fields['usable-lift-agl']!.flags[0] & STATUS_MASK).toBe(STATUS_NO_LIFT);
});

it('stores native fields in sparse block order and leaves the input arrays intact', () => {
  const { frame, mask, coverage } = fixture();
  frame.temp2mK.set([298.15, 299.15, 300.15, 301.15]);
  const before = frame.temp2mK.slice();
  const fields = deriveFrame(frame, mask, { layers: ['sfc-temp-c', 'mslp-hpa'], nativeCoverage: coverage });
  expect(fields['sfc-temp-c']!.values).toHaveLength(frame.activeIndices.length);
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i]!, slot = sparseCoverageLookup(coverage, index % 32, Math.floor(index / 32))!.offset;
    expect(fields['sfc-temp-c']!.values[slot]).toBeCloseTo(25 + i, 4);
    expect(fields['mslp-hpa']!.values[slot]).toBeCloseTo(1013.25, 3);
  }
  expect(frame.temp2mK).toEqual(before);
});

it('preserves per-field missingness without erasing independent surface observations', () => {
  const { frame, mask, coverage } = fixture();
  frame.auxSurface!.u10mMps!.missing[0] = 1;
  frame.missing.surfacePressure[0] = 1;
  const fields = deriveFrame(frame, mask, { layers: ['wind-10m-u', 'wind-10m-v', 'sfc-temp-c', 'surface-lcl-msl'], nativeCoverage: coverage });
  const slot = sparseCoverageLookup(coverage, 0, 0)!.offset;
  expect(fields['wind-10m-u']!.flags[slot]).toBe(STATUS_UNAVAILABLE);
  expect(fields['surface-lcl-msl']!.flags[slot]).toBe(STATUS_UNAVAILABLE);
  expect(fields['wind-10m-v']!.flags[slot]).toBe(STATUS_VALID);
  expect(fields['sfc-temp-c']!.flags[slot]).toBe(STATUS_VALID);
});

it('preserves lift float bytes when adding native diagnostics and cloud support', () => {
  const { frame, mask, coverage } = fixture();
  const baseline = deriveFrame(frame, mask, { layers: ['usable-lift-msl', 'usable-lift-agl'] });
  const enriched = deriveFrame(frame, mask, { layers: LAYER_IDS, nativeCoverage: coverage });
  for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
    expect(new Uint8Array(enriched[layer]!.values.buffer)).toEqual(new Uint8Array(baseline[layer]!.values.buffer));
    for (const index of frame.activeIndices) expect(enriched[layer]!.flags[index]! & ~CLOUD_SUPPORT_MASK).toBe(baseline[layer]!.flags[index]);
  }
});

it('retains complete nighttime profiles per covered cell with independent optional fields', () => {
  const { frame, coverage } = fixture(3);
  frame.auxLevels!.rhPercent![1]!.missing[0] = 1;
  frame.missing.temp[2]![1] = 1;
  const reader = prepareNativeProfiles(frame, coverage);
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const profile = readProfileRecord(reader.readRecord(frame.activeIndices[i]!));
    expect(profile.status).toBe('valid');
    expect(profile.modelTerrainM).toBe(100);
    expect(profile.surfacePressureHpa).toBe(1000);
    expect(profile.levels).toHaveLength(4);
    if (i === 1) expect(profile.levels[2]).toMatchObject({ temperatureC: null, uWindMps: 6 });
    expect(profile.levels[0]!.uWindMps).toBe(4);
    expect(profile.levels[0]!.omegaPaS).toBeNull();
    if (i === 0) expect(profile.levels[1]!.dewPointC).toBeNull();
  }
  expect(() => reader.readRecord(1)).toThrow('not acquired');
});
