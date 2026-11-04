import { expect, it } from 'vitest';
import { STATUS_MASK, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, SUPPORT_PARCEL_CROSSING, SUPPORT_PROFILE_TOP, type CoverageMask, type Grid } from '@av/contracts';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { deriveFrame, deriveSelectedFrameDiagnostics, FRAME_BRANCH, type FrameDiagnostics } from './frame.js';
import { validateNormalizedFrame, type ModelLevelFrame, type NormalizedFrame } from './inputs.js';

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

it.each([100, 500])('preserves a Float32-neutral column with its first level at %s m', firstLevel => {
  const frame = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
  const heights = [firstLevel, ...[500, 1000, 1500, 2000, 2500, 3000, 3500, 4000].filter(height => height > firstLevel)];
  frame.terrainM[0] = 0;
  frame.temp2mK[0] = 293.15;
  frame.specificHumidity2mKgKg[0] = 0.005;
  frame.sensibleHeatFluxWm2[0] = 250;
  frame.latentHeatFluxWm2[0] = 50;
  frame.pressureLevelsHpa = heights.map((_, i) => 990 - i * 40);
  frame.hgtM = heights.map(height => Float32Array.of(height));
  frame.tempK = heights.map(height => Float32Array.of(293.15 - 0.0098 * height));
  frame.missing.hgt = heights.map(() => Uint8Array.of(0));
  frame.missing.temp = heights.map(() => Uint8Array.of(0));
  const diagnostic = diagnostics();
  const surfaceK = frame.temp2mK[0];
  for (const deltaK of [0, 2 ** -15]) {
    frame.temp2mK[0] = surfaceK + deltaK;
    const fields = deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
    expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.profileTop);
    expect(diagnostic.ceilingMslM[0]).toBe(4000);
    for (const layer of layers) {
      expect(fields[layer]!.flags[0]).toBe(STATUS_VALID | SUPPORT_PROFILE_TOP);
      expect(fields[layer]!.values[0]).toBe(4000);
    }
  }

  frame.temp2mK[0] = surfaceK;
  frame.tempK[0][0] += 0.001;
  const stable = deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.surfaceStable);
  for (const layer of layers) {
    expect(stable[layer]!.flags[0]).toBe(STATUS_NO_LIFT);
    expect(stable[layer]!.values[0]).toBe(0);
  }
});

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

it('exposes the level-screening jump at model terrain', () => {
  const frame = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
  frame.hgtM = [500, 1000, 1500].map(height => Float32Array.of(height));
  frame.tempK = [21, 14, 11].map(temperature => Float32Array.of(temperature + 273.15));
  const diagnostic = diagnostics();
  frame.terrainM[0] = 499;
  deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.surfaceStable);
  expect(diagnostic.ceilingMslM[0] - 499).toBe(0);
  frame.terrainM[0] = 500;
  deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.parcelCrossing);
  expect(diagnostic.ceilingMslM[0] - 500).toBeCloseTo(789.47, 1);
});

it.each(layers)('allocates only requested %s output without changing its result', layer => {
  const frame = inversionFrame();
  const both = deriveFrame(frame, mask, { layers });
  const single = deriveFrame(frame, mask, { layers: [layer] });
  expect(Object.keys(single)).toEqual([layer]);
  expect(single[layer]).toEqual(both[layer]);
});

function diagnostics(cells = 1): FrameDiagnostics {
  return { ceilingMslM: new Float32Array(cells), buoyancyM2S3: new Float32Array(cells), branch: new Uint8Array(cells) };
}

function isobaricFrame(): NormalizedFrame {
  return normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
}

it.each(['isobaric', 'model-levels'] as const)('keeps %s layer bytes unchanged with diagnostics enabled', coordinate => {
  const frame = coordinate === 'isobaric' ? isobaricFrame() : inversionFrame();
  const before = structuredClone(frame);
  const without = deriveFrame(frame, mask, { layers });
  const diagnostic = diagnostics();
  const withDiagnostics = deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  for (const layer of layers) {
    expect(Buffer.from(withDiagnostics[layer]!.values.buffer)).toEqual(Buffer.from(without[layer]!.values.buffer));
    expect(withDiagnostics[layer]!.flags).toEqual(without[layer]!.flags);
  }
  expect(frame).toEqual(before);
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.parcelCrossing);
  expect(diagnostic.ceilingMslM[0]).toBeGreaterThan(frame.terrainM[0]);
  expect(diagnostic.buoyancyM2S3[0]).toBeGreaterThan(0);
});

it('retains convective-depth diagnostics when the sink cutoff removes usable lift', () => {
  const frame = isobaricFrame();
  frame.sensibleHeatFluxWm2[0] = 0.1;
  frame.latentHeatFluxWm2[0] = 0;
  const diagnostic = diagnostics();
  const fields = deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(fields['usable-lift-agl']!.flags[0] & STATUS_MASK).toBe(1);
  expect(fields['usable-lift-agl']!.values[0]).toBe(0);
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.parcelCrossing);
  expect(diagnostic.ceilingMslM[0]).toBeGreaterThan(frame.terrainM[0]);
  expect(diagnostic.buoyancyM2S3[0]).toBeGreaterThan(0);
});

it('distinguishes non-convective, profile-top and surface-stable depth diagnostics', () => {
  const frame = isobaricFrame();
  const diagnostic = diagnostics();
  frame.tempK.forEach((values, i) => { values[0] = 273.15 + [17, 12, 7][i]; });
  deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.surfaceStable);
  expect(diagnostic.ceilingMslM[0]).toBe(frame.terrainM[0]);
  expect(diagnostic.buoyancyM2S3[0]).toBe(0);

  frame.tempK.forEach((values, i) => { values[0] = 273.15 + [10, 0, -10][i]; });
  deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.profileTop);
  expect(diagnostic.ceilingMslM[0]).toBe(1600);

  frame.sensibleHeatFluxWm2[0] = 0;
  frame.latentHeatFluxWm2[0] = 0;
  deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.nonConvective);
  expect(diagnostic.ceilingMslM[0]).toBe(frame.terrainM[0]);
  expect(diagnostic.buoyancyM2S3[0]).toBe(0);
});

it('clears unavailable and outside slots when caller-owned diagnostics are reused', () => {
  const largerGrid = { ...grid, width: 2 };
  const largerMask = { ...mask, grid: largerGrid };
  const frame = normalizedFixtureFrame(largerGrid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 12, 1);
  const diagnostic = diagnostics(2);
  diagnostic.ceilingMslM.fill(999);
  diagnostic.buoyancyM2S3.fill(999);
  diagnostic.branch.fill(99);
  deriveFrame(frame, largerMask, { layers, diagnostics: diagnostic });
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.parcelCrossing);
  expect(diagnostic.ceilingMslM[1]).toBeNaN();
  expect(diagnostic.buoyancyM2S3[1]).toBeNaN();
  expect(diagnostic.branch[1]).toBe(FRAME_BRANCH.unavailable);
  frame.missing.temp2m[0] = 1;
  const without = deriveFrame(frame, largerMask, { layers });
  const withDiagnostics = deriveFrame(frame, largerMask, { layers, diagnostics: diagnostic });
  expect(withDiagnostics).toEqual(without);
  expect([...diagnostic.ceilingMslM].every(Number.isNaN)).toBe(true);
  expect([...diagnostic.buoyancyM2S3].every(Number.isNaN)).toBe(true);
  expect([...diagnostic.branch]).toEqual([FRAME_BRANCH.unavailable, FRAME_BRANCH.unavailable]);
});

it('records skipped darkness without physics and preserves published outcomes', () => {
  const frame = normalizedFixtureFrame(grid, Uint32Array.of(0), '2026-06-21T00:00:00Z', 0, 1);
  const diagnostic = diagnostics();
  expect(deriveFrame(frame, mask, { layers, diagnostics: diagnostic })).toEqual(deriveFrame(frame, mask, { layers }));
  const dark = deriveFrame(frame, mask, { layers, diagnostics: diagnostic });
  expect(dark['usable-lift-msl']!.values[0]).toBe(frame.terrainM[0]);
  expect(dark['usable-lift-agl']!.values[0]).toBe(0);
  for (const layer of layers) expect(dark[layer]!.flags[0]).toBe(STATUS_NO_LIFT);
  expect(diagnostic.ceilingMslM[0]).toBeNaN();
  expect(diagnostic.buoyancyM2S3[0]).toBeNaN();
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.skippedDark);
  frame.missing.terrain[0] = 1;
  expect(deriveFrame(frame, mask, { layers, diagnostics: diagnostic })).toEqual(deriveFrame(frame, mask, { layers }));
  expect(diagnostic.ceilingMslM[0]).toBeNaN();
  expect(diagnostic.buoyancyM2S3[0]).toBeNaN();
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.skippedDark);

  const day = isobaricFrame();
  day.tempK[0][0] = 290.15;
  day.missing.temp[0][0] = 1;
  expect(deriveFrame(day, mask, { layers, diagnostics: diagnostic })).toEqual(deriveFrame(day, mask, { layers }));
  expect(diagnostic.ceilingMslM[0]).toBeNaN();
  expect(diagnostic.buoyancyM2S3[0]).toBeNaN();
  expect(diagnostic.branch[0]).toBe(FRAME_BRANCH.unavailable);
});

it('rejects invalid diagnostics before modifying caller arrays or source data', () => {
  const frame = isobaricFrame();
  const before = structuredClone(frame);
  expect(() => deriveFrame(frame, mask, { layers, diagnostics: diagnostics(2) })).toThrow('native grid');
  expect(() => deriveFrame(frame, mask, { layers, diagnostics: { ...diagnostics(), ceilingMslM: new Uint8Array(1) as unknown as Float32Array } })).toThrow('declared types');
  expect(() => deriveFrame(frame, mask, { layers, diagnostics: { ...diagnostics(), ceilingMslM: frame.terrainM } })).toThrow('alias frame inputs');
  expect(() => deriveFrame(frame, mask, { layers, diagnostics: { ...diagnostics(), branch: mask.output } })).toThrow('alias frame inputs');
  const shared = diagnostics();
  expect(() => deriveFrame(frame, mask, { layers, diagnostics: { ...shared, buoyancyM2S3: shared.ceilingMslM } })).toThrow('alias each other');
  expect(() => deriveFrame(frame, mask, { layers: ['precip-rate'], diagnostics: diagnostics() })).toThrow('require a usable-lift layer');
  expect(frame).toEqual(before);
});

it.each(['isobaric', 'model-levels'] as const)('derives selected %s diagnostics with full-frame byte parity', coordinate => {
  const largerGrid = { ...grid, width: 4 };
  const largerMask = { ...mask, grid: largerGrid, output: Uint8Array.of(11) };
  const original = normalizedFixtureFrame(largerGrid, Uint32Array.of(0, 1, 3), '2026-06-21T00:00:00Z', 0, 1);
  const pressurePa = original.pressureLevelsHpa.map(p => new Float32Array(3).fill(p * 100));
  const frame: NormalizedFrame = coordinate === 'isobaric' ? original : {
    ...original, pressureLevelsHpa: undefined, pressurePa,
    missing: { ...original.missing, pressure: pressurePa.map(() => new Uint8Array(3)) }
  };
  frame.missing.temp[1]![2] = 1;
  const before = structuredClone(frame), fullDiagnostics = diagnostics(4);
  const full = deriveFrame(frame, largerMask, { layers, daylightOnly: false, diagnostics: fullDiagnostics });
  const selected = deriveSelectedFrameDiagnostics(frame, Uint32Array.of(0, 3));
  expect(selected.bufferBytes).toBe(40);
  for (const index of [0, 3]) {
    expect(selected.flags[index]).toBe(full['usable-lift-agl']!.flags[index]);
    expect(selected.diagnostics.branch[index]).toBe(fullDiagnostics.branch[index]);
    for (const key of ['ceilingMslM', 'buoyancyM2S3'] as const) {
      expect(Buffer.from(selected.diagnostics[key].buffer, index * 4, 4)).toEqual(Buffer.from(fullDiagnostics[key].buffer, index * 4, 4));
    }
  }
  expect(selected.flags[0]! & STATUS_MASK).toBe(STATUS_VALID);
  expect(selected.flags[3]).toBe(STATUS_UNAVAILABLE);
  for (const index of [1, 2]) {
    expect(selected.flags[index]).toBe(STATUS_OUTSIDE);
    expect(selected.diagnostics.branch[index]).toBe(FRAME_BRANCH.unavailable);
    expect(selected.diagnostics.ceilingMslM[index]).toBeNaN();
    expect(selected.diagnostics.buoyancyM2S3[index]).toBeNaN();
  }
  expect(frame).toEqual(before);
});

it('rejects invalid selected indices and malformed normalized frames', () => {
  const largerGrid = { ...grid, width: 4 };
  const frame = normalizedFixtureFrame(largerGrid, Uint32Array.of(0, 1, 3), '2026-06-21T00:00:00Z', 12, 1);
  for (const selection of [Uint32Array.of(), Uint32Array.of(4), Uint32Array.of(0, 0), Uint32Array.of(3, 0), Uint32Array.of(2)]) {
    expect(() => deriveSelectedFrameDiagnostics(frame, selection)).toThrow();
  }
  const unordered = { ...frame, activeIndices: Uint32Array.of(0, 3, 1) };
  expect(() => deriveSelectedFrameDiagnostics(unordered, Uint32Array.of(0))).toThrow(/active indices/);
  expect(() => deriveSelectedFrameDiagnostics({ ...frame, grid: { ...largerGrid, width: 4_000_001 } }, Uint32Array.of(0))).toThrow();
  expect(() => deriveSelectedFrameDiagnostics({ ...frame, temp2mK: Float32Array.of(1) }, Uint32Array.of(0))).toThrow(/dimensions/);
  frame.temp2mK[0] = NaN;
  expect(() => deriveSelectedFrameDiagnostics(frame, Uint32Array.of(0))).toThrow(/nonfinite/);
});
