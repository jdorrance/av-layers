import { describe, expect, it } from 'vitest';
import { GFS_GRID } from '@av/contracts';
import { validateNormalizedFrame, type NormalizedFrame } from './providers.js';

function frame(): NormalizedFrame {
  const values = () => Float32Array.of(1), missing = () => Uint8Array.of(0), time = '2026-10-30T00:00:00Z', window = { start: time, end: time };
  return { cycle: time, hour: 3, validAt: time, capturedAt: time, grid: GFS_GRID, activeIndices: Uint32Array.of(0), terrainM: values(), surfacePressurePa: values(), temp2mK: values(), specificHumidity2mKgKg: values(), pblHeightM: values(), sensibleHeatFluxWm2: values(), latentHeatFluxWm2: values(), precipitationMmPerHour: values(), pressureLevelsHpa: [900], hgtM: [values()], tempK: [values()], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), pbl: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing()], temp: [missing()] }, intervals: { profileTime: time, fluxWindow: window, precipitationWindow: window, fluxSourceWindow: window, precipitationSourceWindow: window, usedCompanion: false }, receipt: {} };
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
});
