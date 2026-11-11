import { describe, expect, it } from 'vitest';
import { setBit, STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type CoverageMask } from '@av/contracts';
import { deriveFrame, sampleGrid, type IsobaricFrame } from '@av/forecast';
import { INDEXED_GRID } from '../../../tests/model-fixtures.js';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';

describe('frame derivation', () => {
  function fixture(hour = 12): { input: IsobaricFrame; mask: CoverageMask; index: number } {
    const index = 360 * INDEXED_GRID.width + 720;
    const bits = Math.ceil(INDEXED_GRID.width * INDEXED_GRID.height / 8);
    const mask: CoverageMask = { grid: INDEXED_GRID, output: new Uint8Array(bits), halo: new Uint8Array(bits), tiles: new Uint8Array(1), maxZoom: 0 };
    setBit(mask.output, index); setBit(mask.halo, index + 1);
    const values = (v: number) => new Float32Array([v, v]);
    const missing = () => new Uint8Array(2);
    const activeIndices = Uint32Array.of(index, index + 1);
    const input = { ...normalizedFixtureFrame(INDEXED_GRID, activeIndices, '2026-10-30T00:00:00.000Z', hour, 1), terrainM: values(100), surfacePressurePa: values(100000), temp2mK: values(293.15), specificHumidity2mKgKg: values(0.008), sensibleHeatFluxWm2: values(250), latentHeatFluxWm2: values(100), precipitationMmPerHour: new Float32Array([2, 4]), pressureLevelsHpa: [990, 950, 900], hgtM: [new Float32Array([100, 90]), values(600), values(1100)], tempK: [values(290), values(286.15), values(281.15)], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing(), missing(), missing()], temp: [missing(), missing(), missing()] } };
    return { input, mask, index };
  }

  it('derives halo contributors without publishing halo-only points', () => {
    const { input, mask, index } = fixture(12), fields = deriveFrame(input, mask);
    expect(fields['precip-rate']!.flags[index + 1]).toBe(STATUS_VALID);
    expect(fields['usable-lift-agl']!.flags[index + 1] & STATUS_MASK).not.toBe(STATUS_UNAVAILABLE);
    const sample = sampleGrid(INDEXED_GRID, fields['precip-rate']!, 0, 0.1, 'precip-rate', mask, false);
    expect(sample).toMatchObject({ status: STATUS_VALID, interpolated: true });
    expect(sample.value).toBeCloseTo(2.8);
    expect(sampleGrid(INDEXED_GRID, fields['precip-rate']!, 0, 0.25, 'precip-rate', mask, false).status).toBe(STATUS_OUTSIDE);
  });

  it('drops finite subterranean heights but not missing profile levels', () => {
    const { input, mask, index } = fixture(12);
    expect(deriveFrame(input, mask)['usable-lift-agl']!.flags[index] & STATUS_MASK).toBe(STATUS_VALID);
    expect(deriveFrame(input, mask)['usable-lift-agl']!.flags[index + 1] & STATUS_MASK).toBe(STATUS_VALID);
    input.missing.hgt[1][0] = 1;
    input.missing.temp[1][1] = 1;
    expect(deriveFrame(input, mask)['usable-lift-agl']!.flags[index] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
    expect(deriveFrame(input, mask)['usable-lift-agl']!.flags[index + 1] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  });

  it('skips dark convective columns while retaining precipitation', () => {
    // At 03:00 UTC, (lat=0, lon=0) is in nighttime darkness
    const { input, mask, index } = fixture(3);
    const nightFields = deriveFrame(input, mask);
    expect(nightFields['usable-lift-msl']!.flags[index]).toBe(STATUS_NO_LIFT);
    expect(nightFields['usable-lift-msl']!.values[index]).toBe(100);
    expect(nightFields['usable-lift-agl']!.flags[index]).toBe(STATUS_NO_LIFT);
    expect(nightFields['usable-lift-agl']!.values[index]).toBe(0);
    expect(nightFields['precip-rate']!.flags[index]).toBe(STATUS_VALID);
    expect(nightFields['precip-rate']!.values[index]).toBe(2);

    const unGatedFields = deriveFrame(input, mask, { daylightOnly: false });
    expect(unGatedFields['usable-lift-agl']!.flags[index] & STATUS_MASK).toBe(STATUS_VALID);
    expect(unGatedFields['precip-rate']!.flags[index]).toBe(STATUS_VALID);
    expect(unGatedFields['precip-rate']!.values[index]).toBe(2);
  });
});
