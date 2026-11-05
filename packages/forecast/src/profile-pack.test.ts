import { expect, it } from 'vitest';
import { PROFILE_OMEGA_UNITS_PER_PA_S, STATUS_OUTSIDE, STATUS_UNAVAILABLE } from '@av/contracts';
import { omegaFromGeometricWPaS } from '@av/thermodynamics';
import { profileRecordBytes, readProfileRecord, validateProfileRecord, writeProfileRecord, type NativeProfileInput, type ProfileLevelInput } from './profile-pack.js';

const level = (heightM = 1000, pressureHpa = 900): ProfileLevelInput => ({
  pressureHpa, heightM, temperatureC: 12.345, dewPointC: 5.678,
  uWindMps: -12.345, vWindMps: 8.765, omegaPaS: -0.1234
});
const profile = (levels: readonly ProfileLevelInput[] = [level()]): NativeProfileInput => ({ modelTerrainM: 123.4, status: 'valid', levels });

it('writes the versioned little-endian column header and quantized levels into a borrowed record', () => {
  const buffer = new Uint8Array(profileRecordBytes(2) + 7).fill(255), bytes = buffer.subarray(3, -4);
  writeProfileRecord(bytes, profile());
  expect([...bytes.subarray(0, 8)]).toEqual([123, 0, 1, 0, 0, 1, 0, 0]);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint16(8, true)).toBe(9000);
  expect(view.getInt16(10, true)).toBe(1000);
  expect(view.getInt16(12, true)).toBe(1235);
  expect(view.getInt16(14, true)).toBe(568);
  expect(view.getInt16(16, true)).toBe(-1234);
  expect(view.getInt16(18, true)).toBe(877);
  expect(view.getInt16(20, true)).toBe(-1);
  expect([...bytes.subarray(22)]).toEqual(Array(14).fill(0));
  expect([...buffer.subarray(0, 3)]).toEqual([255, 255, 255]);
  expect([...buffer.subarray(-4)]).toEqual([255, 255, 255, 255]);
  expect(readProfileRecord(bytes)).toEqual({ modelTerrainM: 123, surfacePressureHpa: null, status: 'valid', levels: [{
    pressureHpa: 900, heightM: 1000, temperatureC: 12.35, dewPointC: 5.68,
    uWindMps: -12.34, vWindMps: 8.77, omegaPaS: -0.1
  }] });
  expect(() => validateProfileRecord(bytes)).not.toThrow();
});

it('preserves 256 levels with a uint16 count', () => {
  const bytes = new Uint8Array(profileRecordBytes(256));
  writeProfileRecord(bytes, profile(Array.from({ length: 256 }, (_, i) => level(200 + i * 10, 1000 - i))));
  expect([...bytes.subarray(2, 4)]).toEqual([0, 1]);
  expect(readProfileRecord(bytes).levels).toHaveLength(256);
});

it('retains row slots and independent values when pressure, height or temperature is missing', () => {
  const bytes = new Uint8Array(profileRecordBytes(4));
  writeProfileRecord(bytes, profile([
    { ...level(1000, 950), pressureHpa: null }, { ...level(1100, 900), heightM: null }, { ...level(1200, 850), temperatureC: null },
    { ...level(1300, 800), dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null }
  ]));
  expect(readProfileRecord(bytes)).toMatchObject({ status: 'valid', levels: [
    { pressureHpa: null, heightM: 1000, temperatureC: 12.35, uWindMps: -12.34 },
    { pressureHpa: 900, heightM: null, temperatureC: 12.35, uWindMps: -12.34 },
    { pressureHpa: 850, heightM: 1200, temperatureC: null, uWindMps: -12.34 },
    { pressureHpa: 800, heightM: 1300, temperatureC: 12.35, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null }
  ] });
  const view = new DataView(bytes.buffer);
  expect(view.getUint16(8, true)).toBe(0);
  for (const offset of [24, 40, 56, 58, 60, 62]) expect(view.getInt16(offset, true)).toBe(-32768);
  expect(() => validateProfileRecord(bytes)).not.toThrow();
  const missing = { pressureHpa: null, heightM: null, temperatureC: null, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null };
  writeProfileRecord(bytes, profile([missing]));
  expect(readProfileRecord(bytes)).toMatchObject({ status: 'valid', levels: [missing] });
});

it('retains independent rows and measured pressure when model ground is unavailable', () => {
  const bytes = new Uint8Array(profileRecordBytes(1));
  writeProfileRecord(bytes, { ...profile(), modelTerrainM: null, surfacePressureHpa: 1000, status: 'unavailable' });
  expect(readProfileRecord(bytes)).toMatchObject({ modelTerrainM: null, surfacePressureHpa: 1000, status: 'unavailable',
    levels: [{ pressureHpa: 900, heightM: 1000, temperatureC: 12.35 }] });
  expect(() => validateProfileRecord(bytes)).not.toThrow();
});

it.each(['outside-domain', 'unavailable'] as const)('encodes %s independently of valid columns', status => {
  const bytes = new Uint8Array(profileRecordBytes(1)).fill(255);
  writeProfileRecord(bytes, { modelTerrainM: null, status, levels: [] });
  expect(new DataView(bytes.buffer).getInt16(0, true)).toBe(-32768);
  expect(bytes[4]).toBe(status === 'outside-domain' ? STATUS_OUTSIDE : STATUS_UNAVAILABLE);
  expect(readProfileRecord(bytes)).toEqual({ modelTerrainM: null, surfacePressureHpa: null, status, levels: [] });
});

it('rejects overflow and invalid order rather than clipping physical data', () => {
  const bytes = new Uint8Array(profileRecordBytes(2));
  for (const change of [
    { pressureHpa: 0 }, { pressureHpa: 6554 }, { heightM: 32768 }, { heightM: 122 },
    { temperatureC: -327.68 }, { dewPointC: 328 }, { uWindMps: NaN }, { vWindMps: Infinity }, { omegaPaS: 3276.8 }
  ]) expect(() => writeProfileRecord(bytes, profile([{ ...level(), ...change }]))).toThrow();
  for (const levels of [[level(1000, 900), level(999, 800)], [level(1000, 900), level(1100, 950)],
    [level(1000, 900), level(1000.1, 800)], [level(1000, 900), level(1100, 899.99)]]) {
    expect(() => writeProfileRecord(bytes, profile(levels))).toThrow('ascending heights and descending pressures');
  }
  const gaps = new Uint8Array(profileRecordBytes(3));
  for (const levels of [
    [level(1000, 900), { ...level(1100, 850), heightM: null }, level(999, 800)],
    [level(1000, 900), { ...level(1100, 850), pressureHpa: null }, level(1200, 950)]
  ]) expect(() => writeProfileRecord(gaps, profile(levels))).toThrow('ascending heights and descending pressures');
  expect(() => writeProfileRecord(bytes, { ...profile(), modelTerrainM: -32768 })).toThrow('encoded range');
  expect(() => writeProfileRecord(bytes, { ...profile(), modelTerrainM: null })).toThrow('status or terrain');
  expect(() => writeProfileRecord(bytes, { ...profile(), status: 'unavailable' })).toThrow('status or terrain');
  expect(() => writeProfileRecord(bytes, profile([level(), level(), level()]))).toThrow('capacity');
});

it('rejects malformed headers, levels, padding and record widths on both read paths', () => {
  for (const mutate of [
    (view: DataView) => view.setUint8(4, 1),
    (view: DataView) => view.setUint8(5, 2),
    (view: DataView) => view.setUint16(2, 3, true),
    (view: DataView) => view.setUint16(2, 0, true),
    (view: DataView) => view.setInt16(0, -32768, true),
    (view: DataView) => view.setInt16(10, 122, true),
    (view: DataView) => view.setUint8(22, 1)
  ]) {
    const bytes = new Uint8Array(profileRecordBytes(2));
    writeProfileRecord(bytes, profile());
    mutate(new DataView(bytes.buffer));
    expect(() => readProfileRecord(bytes)).toThrow();
    expect(() => validateProfileRecord(bytes)).toThrow();
  }
  for (const capacity of [0, 1.5, 257, Infinity]) expect(() => profileRecordBytes(capacity)).toThrow('capacity');
  for (const length of [0, 8, 21, 23, 4096]) expect(() => readProfileRecord(new Uint8Array(length))).toThrow();
});


it('preserves measured surface pressure in the fixed-width header', () => {
  const bytes = new Uint8Array(profileRecordBytes(1));
  writeProfileRecord(bytes, { ...profile(), surfacePressureHpa: 999.94 });
  expect(new DataView(bytes.buffer).getUint16(6, true)).toBe(9999);
  expect(readProfileRecord(bytes).surfacePressureHpa).toBe(999.9);
  for (const surfacePressureHpa of [0, -1, NaN, 6553.6]) {
    expect(() => writeProfileRecord(bytes, { ...profile(), surfacePressureHpa })).toThrow('encoded range');
  }
  expect(() => writeProfileRecord(bytes, { modelTerrainM: null, surfacePressureHpa: 1000, status: 'outside-domain', levels: [] })).toThrow('status or terrain');
});


it('retains strong resolved drafts within source-supported omega precision', () => {
  expect(PROFILE_OMEGA_UNITS_PER_PA_S).toBe(10);
  const bytes = new Uint8Array(profileRecordBytes(1));
  for (const [pressureHpa, temperatureC] of [[1000, 15], [400, -23.15]]) for (const wMps of [-100, -50, 50, 100]) {
    const omegaPaS = omegaFromGeometricWPaS(wMps, pressureHpa, temperatureC);
    writeProfileRecord(bytes, profile([{ ...level(), pressureHpa, temperatureC, omegaPaS }]));
    expect(Math.abs(readProfileRecord(bytes).levels[0]!.omegaPaS! - omegaPaS)).toBeLessThanOrEqual(0.05);
  }
  // RRFS 2026-11-05 00Z f001: DZDT half-step is 0.015625 m/s at all 25 selected levels.
  for (const [pressureHpa, temperatureC] of [[1000, 15], [400, -23.15]]) {
    expect(Math.abs(omegaFromGeometricWPaS(0.015625, pressureHpa, temperatureC))).toBeGreaterThan(0.05);
  }
});
