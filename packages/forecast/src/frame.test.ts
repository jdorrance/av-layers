import { expect, it } from 'vitest';
import { STATUS_MASK, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, type CoverageMask, type Grid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { deriveFrame } from './frame.js';
import { validateNormalizedFrame, type ModelLevelFrame } from './inputs.js';

const grid: Grid = { kind: 'regular-latlon', earthRadiusM: 6371229, width: 1, height: 1, lon0: 0, lat0: 0, dx: 1, dy: -1, wrapLongitude: false };
const mask: CoverageMask = { grid, output: Uint8Array.of(1), halo: Uint8Array.of(0), tiles: Uint8Array.of(1), maxZoom: 0 };
const layers = ['usable-lift-msl', 'usable-lift-agl'] as const;

function inversionFrame(): ModelLevelFrame {
  const frame = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
  frame.terrainM[0] = 0;
  frame.temp2mK[0] = 303.15;
  frame.sensibleHeatFluxWm2[0] = 300;
  frame.hgtM = [100, 300, 600].map(height => Float32Array.of(height));
  frame.tempK = [28, 30, 23].map(temperature => Float32Array.of(temperature + 273.15));
  const pressurePa = [99000, 97000, 94000].map(pressure => Float32Array.of(pressure));
  return { ...frame, pressureLevelsHpa: undefined, pressurePa, missing: { ...frame.missing, pressure: pressurePa.map(() => Uint8Array.of(0)) } };
}

it('preserves a missing pressure observation instead of bridging an inversion into valid lift', () => {
  const frame = inversionFrame();
  const complete = deriveFrame(frame, mask, { layers });
  expect(complete['usable-lift-agl']!.flags[0]).toBe(STATUS_VALID | SUPPORT_PARCEL_CROSSING);
  expect(complete['usable-lift-agl']!.values[0]).toBeCloseTo(135.53, 2);

  frame.missing.pressure![1][0] = 1;
  expect(() => validateNormalizedFrame(frame, frame.activeIndices, grid, 3, layers, 'model-levels')).not.toThrow();
  const missing = deriveFrame(frame, mask, { layers });
  for (const layer of layers) {
    expect(missing[layer]!.flags[0]).toBe(STATUS_UNAVAILABLE);
    expect(missing[layer]!.values[0]).toBeNaN();
  }
});

it.each([0, -1, NaN])('keeps invalid above-ground pressure %s unavailable', pressure => {
  const frame = inversionFrame();
  frame.pressurePa![1][0] = pressure;
  frame.missing.pressure![1][0] = Number.isFinite(pressure) ? 0 : 1;
  validateNormalizedFrame(frame, frame.activeIndices, grid, 3, layers, 'model-levels');
  const fields = deriveFrame(frame, mask, { layers });
  for (const layer of layers) expect(fields[layer]!.flags[0]).toBe(STATUS_UNAVAILABLE);
});

it.each(['height', 'pressure'] as const)('still screens a level established below ground by %s', evidence => {
  const frame = inversionFrame();
  if (evidence === 'height') {
    frame.hgtM[0][0] = -10;
    frame.missing.pressure![0][0] = 1;
  } else {
    frame.pressurePa![0][0] = frame.surfacePressurePa[0] + 1000;
    frame.missing.hgt[0][0] = 1;
  }
  frame.missing.temp[0][0] = 1;
  validateNormalizedFrame(frame, frame.activeIndices, grid, 3, layers, 'model-levels');
  const fields = deriveFrame(frame, mask, { layers });
  for (const layer of layers) expect(fields[layer]!.flags[0] & STATUS_MASK).not.toBe(STATUS_UNAVAILABLE);
});

it.each(layers)('allocates only requested %s output without changing its result', layer => {
  const frame = inversionFrame();
  const both = deriveFrame(frame, mask, { layers });
  const single = deriveFrame(frame, mask, { layers: [layer] });
  expect(Object.keys(single)).toEqual([layer]);
  expect(single[layer]).toEqual(both[layer]);
});
