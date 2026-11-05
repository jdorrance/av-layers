import { expect, it } from 'vitest';
import { sparseCoverageFromDense, type RegularLatLonGrid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { prepareNativeProfiles } from './native-fields.js';
import { profileRecordBytes, readProfileRecord, writeProfileRecord } from './profile-pack.js';
import { nativeColumnCloudDiagnostics, nativeColumnWindAtHeight } from '@av/soaring';

function fixture(width = 4, height = 3) {
  const grid: RegularLatLonGrid = { kind: 'regular-latlon', width, height, wrapLongitude: false, earthRadiusM: 6371229, lon0: -100, lat0: 50, dx: 0.01, dy: -0.01 };
  const cells = width * height, active = Uint32Array.from({ length: cells }, (_, i) => i);
  const frame = normalizedFixtureFrame(grid, active, '2026-06-21T00:00:00.000Z', 12, 1);
  const output = new Uint8Array(Math.ceil(cells / 8)).fill(255), halo = new Uint8Array(output.length);
  if (cells % 8) output[output.length - 1] &= (1 << (cells % 8)) - 1;
  const coverage = sparseCoverageFromDense({ width, height, wrapLongitude: false, gridHash: 'a'.repeat(64), output, halo });
  return { frame, coverage, cells };
}

it('streams one borrowed native column with measured surface pressure and optional missing values', () => {
  const { frame, coverage, cells } = fixture(), width = profileRecordBytes(3);
  frame.terrainM[1] = 105;
  frame.surfacePressurePa[1] = 99994;
  frame.missing.temp[0][1] = 1;
  const profiles = prepareNativeProfiles(frame, coverage), first = profiles.readRecord(0), saved = Uint8Array.from(first);
  expect(profiles.byteLength).toBe(cells * 4 + width);
  expect(readProfileRecord(saved)).toMatchObject({ modelTerrainM: 100, surfacePressureHpa: 1000, status: 'valid', levels: expect.any(Array) });
  const second = profiles.readRecord(1);
  expect(second).toBe(first);
  expect(readProfileRecord(second)).toMatchObject({ modelTerrainM: 105, surfacePressureHpa: 999.9,
    levels: [{ pressureHpa: 950, temperatureC: null, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null },
      { pressureHpa: 900, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null },
      { pressureHpa: 850, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null }] });
  expect(readProfileRecord(saved).modelTerrainM).toBe(100);
  for (const index of [-1, 0.5, cells, Infinity]) expect(() => profiles.readRecord(index)).toThrow('was not acquired');
});

it('retains a bounded ordinal index and defers decoding until the column is requested', () => {
  const { frame, coverage, cells } = fixture(500, 200);
  frame.tempK[0]![cells - 1] = 1e20;
  const profiles = prepareNativeProfiles(frame, coverage);
  expect(profiles.byteLength).toBe(cells * 4 + profileRecordBytes(3));
  expect(profiles.byteLength).toBeLessThan(cells * profileRecordBytes(3) / 10);
  expect(() => profiles.readRecord(0)).not.toThrow();
  expect(() => profiles.readRecord(cells - 1)).toThrow('encoded range');
});

it('retains upper-air rows and pressure when model terrain is missing', () => {
  const { frame, coverage } = fixture();
  frame.missing.terrain[0] = 1;
  const profile = readProfileRecord(prepareNativeProfiles(frame, coverage).readRecord(0));
  expect(profile).toMatchObject({ modelTerrainM: null, surfacePressureHpa: 1000, status: 'unavailable' });
  expect(profile.levels).toHaveLength(3);
  expect(profile.levels[0]).toMatchObject({ heightM: 600, pressureHpa: 950 });
});

it.each(['temperature', 'pressure', 'height'] as const)('preserves dependent integral missingness through a %s gap', gap => {
  const input = { terrainM: 100, surfacePressureHpa: 1000, surfaceTemperatureC: 24, surfaceDewPointC: 15, wind10mU: 0, wind10mV: 0,
    levels: [
      { heightM: 200, pressureHpa: 980, temperatureC: 22, dewPointC: 14, uMps: 2, vMps: 0 },
      { heightM: gap === 'height' ? NaN : 500, pressureHpa: gap === 'pressure' ? NaN : 950,
        temperatureC: gap === 'temperature' ? NaN : 18, dewPointC: 12, uMps: 20, vMps: 0 },
      { heightM: 1000, pressureHpa: 900, temperatureC: 14, dewPointC: 8, uMps: 4, vMps: 0 }
    ] };
  const present = (value: number) => Number.isFinite(value) ? value : null, bytes = new Uint8Array(profileRecordBytes(3));
  writeProfileRecord(bytes, { modelTerrainM: input.terrainM, surfacePressureHpa: input.surfacePressureHpa, status: 'valid',
    levels: input.levels.map(level => ({ pressureHpa: present(level.pressureHpa), heightM: present(level.heightM), temperatureC: present(level.temperatureC),
      dewPointC: level.dewPointC, uWindMps: level.uMps, vWindMps: level.vMps, omegaPaS: null })) });
  const decoded = readProfileRecord(bytes), restored = { ...input,
    levels: decoded.levels.map(level => ({ pressureHpa: level.pressureHpa, heightM: level.heightM ?? NaN, temperatureC: level.temperatureC ?? NaN,
      dewPointC: level.dewPointC, uMps: level.uWindMps, vMps: level.vWindMps })) };
  expect(decoded.levels).toHaveLength(3);
  expect(decoded.levels[1]!.uWindMps).toBe(20);
  expect(nativeColumnCloudDiagnostics(restored, 700).mixedLayerLclM).toBeNull();
  expect(nativeColumnCloudDiagnostics(restored, 700)).toEqual(nativeColumnCloudDiagnostics(input, 700));
  const wind = nativeColumnWindAtHeight(restored, 700);
  expect(wind).toEqual(nativeColumnWindAtHeight(input, 700));
  expect(wind.blTopWindU).toBe(gap === 'height' ? null : 13.6);
});
