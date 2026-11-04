import { describe, expect, it } from 'vitest';
import { GFS_GRID } from '@av/contracts';
import { validateNormalizedFrame, type ModelLevelFrame, type NormalizedFrame } from './inputs.js';

function frame(): NormalizedFrame & {
  precipitationMmPerHour: Float32Array;
  pressureLevelsHpa: readonly number[];
} {
  const values = () => Float32Array.of(1), missing = () => Uint8Array.of(0), time = '2026-10-30T00:00:00Z', window = { start: time, end: time };
  return { cycle: time, hour: 3, validAt: time, capturedAt: time, grid: GFS_GRID, activeIndices: Uint32Array.of(0), terrainM: values(), surfacePressurePa: values(), temp2mK: values(), specificHumidity2mKgKg: values(), sensibleHeatFluxWm2: values(), latentHeatFluxWm2: values(), precipitationMmPerHour: values(), pressureLevelsHpa: [900], hgtM: [values()], tempK: [values()], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing()], temp: [missing()] }, intervals: { profileTime: time, fluxWindow: window, precipitationWindow: window, fluxSourceWindow: window, precipitationSourceWindow: window, usedCompanion: false }, receipt: {} };
}
const validate = (input: NormalizedFrame) => validateNormalizedFrame(input, Uint32Array.of(0), GFS_GRID, 21);

describe('normalized provider admission', () => {
  it('accepts compact Float32 fields and explicitly masked missing values', () => {
    const input = frame(); validate(input);
    input.tempK[0][0] = NaN; input.missing.temp[0][0] = 1;
    expect(() => validate(input)).not.toThrow();
  });
  it.each(['float64', 'boxed field', 'boxed indices', 'nonbyte mask', 'invalid mask', 'unmasked NaN', 'unmasked Infinity', 'wrong dimensions', 'wrong indices', 'nondecreasing levels'] as const)('rejects %s before scientific computation', defect => {
    const input = frame();
    if (defect === 'float64') input.terrainM = Float64Array.of(1) as unknown as Float32Array;
    if (defect === 'boxed field') input.terrainM = [1] as unknown as Float32Array;
    if (defect === 'boxed indices') input.activeIndices = [0] as unknown as Uint32Array;
    if (defect === 'nonbyte mask') input.missing.hgt[0] = Float32Array.of(0) as unknown as Uint8Array;
    if (defect === 'invalid mask') input.missing.terrain[0] = 2;
    if (defect === 'unmasked NaN') input.hgtM[0][0] = NaN;
    if (defect === 'unmasked Infinity') input.precipitationMmPerHour[0] = Infinity;
    if (defect === 'wrong dimensions') input.tempK[0] = new Float32Array(2);
    if (defect === 'wrong indices') input.activeIndices[0] = 1;
    if (defect === 'nondecreasing levels') input.pressureLevelsHpa = [900, 950];
    expect(() => validate(input)).toThrow(/Normalized|normalized/);
  });

  it('admits either vertical representation and enforces the product coordinate', () => {
    const isobaric = frame();
    const modelLevels: ModelLevelFrame = {
      ...isobaric, pressureLevelsHpa: undefined, pressurePa: [Float32Array.of(90000)],
      missing: { ...isobaric.missing, pressure: [Uint8Array.of(0)] }
    };
    expect(() => validateNormalizedFrame(modelLevels, modelLevels.activeIndices, GFS_GRID, 1, undefined, 'model-levels')).not.toThrow();
    expect(() => validateNormalizedFrame(isobaric, isobaric.activeIndices, GFS_GRID, 1, undefined, 'model-levels')).toThrow('vertical axis');
    expect(() => validateNormalizedFrame(modelLevels, modelLevels.activeIndices, GFS_GRID, 1, undefined, 'isobaric')).toThrow('vertical axis');
  });

  it.each(['both representations', 'neither representation', 'unpaired pressure mask', 'missing pressure mask', 'wrong pressure count'] as const)('rejects %s at the provider boundary', defect => {
    const input = frame();
    const pressurePa = [Float32Array.of(90000)];
    const pressure = [Uint8Array.of(0)];
    const malformed = {
      ...input,
      pressureLevelsHpa: defect === 'both representations' || defect === 'unpaired pressure mask' ? input.pressureLevelsHpa : undefined,
      pressurePa: defect === 'neither representation' || defect === 'unpaired pressure mask' ? undefined : pressurePa,
      missing: { ...input.missing, pressure: defect === 'missing pressure mask' ? undefined : defect === 'wrong pressure count' ? [] : pressure }
    } as unknown as NormalizedFrame;
    expect(() => validate(malformed)).toThrow('vertical axis');
  });

  it('clamps mild GRIB quantization supersaturation up to 105% RH while preserving corrupt humidity for rejection', async () => {
    const { createNativeColumnScratch, readNativeColumn } = await import('./column-input.js');
    const input = frame();
    input.terrainM[0] = 2588.5;
    input.surfacePressurePa[0] = 74459.8;
    input.temp2mK[0] = 274.7757;
    input.specificHumidity2mKgKg[0] = 0.0058656; // ~101.82% RH from GRIB2 CCSDS quantization
    const scratch = createNativeColumnScratch(2);
    readNativeColumn(input, 0, scratch);
    expect(scratch.humidity.specificHumidityKgKg).toBeLessThan(0.0058656);
    expect(scratch.humidity.specificHumidityKgKg).toBeCloseTo(0.005761, 5);
    input.specificHumidity2mKgKg[0] = 0.0065; // >112% RH -> untouched so column solver rejects it
    readNativeColumn(input, 0, scratch);
    expect(scratch.humidity.specificHumidityKgKg).toBeCloseTo(0.0065, 6);
  });
});
