import { expect, it, vi } from 'vitest';
import { deriveLift, ReconstructedProfileWorkspace, type ColumnInput } from './index.js';

function donor(): ColumnInput {
  return { terrainM: 1500, surfaceTemperatureC: 20, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0,
    levels: [{ heightM: 2500, temperatureC: 14 }, { heightM: 3000, temperatureC: 11 }, { heightM: 3500, temperatureC: 8 }] };
}

it('admits only native-valid donors and reconstructs a certified 1500 m bridge', () => {
  const input = donor(), workspace = new ReconstructedProfileWorkspace(1, 3);
  expect(workspace.admit(0, input, 3)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 0, 1500)).toBe(true);
  expect(workspace.levelCount).toBe(4);
  expect(workspace.bridgeUsed).toBe(true);
  const result = workspace.solve({ surfaceTemperatureC: 30, surfacePressureHpa: 1000,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(result.status).not.toBe('unavailable');
  expect(deriveLift({ ...input, terrainM: 0 }, 3).status).toBe('unavailable');
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, -1, 1500)).toBe(false);
  expect(workspace.failure).toBe('belowGroundBridgeExceeded');
  expect(() => workspace.solve(input)).toThrow();
  expect(workspace.admit(0, { ...input, levels: [input.levels[0]!, { heightM: 3600, temperatureC: 10 }] }, 2)).toBe(false);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 1500, 1500)).toBe(false);
});

it('checks an explicit ground anchor while retaining native and non-convective behavior', () => {
  const input = donor();
  expect(deriveLift({ ...input, surfaceEnvironmentTemperatureC: 21 }, 3).branch).toBe('surface-stable');
  const neutral = { ...input, levels: [{ heightM: 2500, temperatureC: 10.2 }, { heightM: 3000, temperatureC: 5.3 }, { heightM: 3500, temperatureC: 0.4 }] };
  expect(deriveLift({ ...neutral, surfaceEnvironmentTemperatureC: 20 + 1e-6 }, 3).branch).not.toBe('surface-stable');
  expect(deriveLift({ ...input, surfaceEnvironmentTemperatureC: 21, sensibleHeatFluxWm2: 0 }, 3).branch).toBe('non-convective');
  expect(deriveLift({ ...input, surfaceEnvironmentTemperatureC: -273.15 }, 3).status).toBe('unavailable');
  expect(deriveLift(input, 3)).toEqual(deriveLift({ ...input, surfaceEnvironmentTemperatureC: undefined }, 3));
});

it('owns donor values and clears reconstruction state on admission and reset', () => {
  const input = donor(), workspace = new ReconstructedProfileWorkspace(1, 3);
  expect(workspace.admit(0, input, 3)).toBe(true);
  (input.levels[0] as { temperatureC: number }).temperatureC = NaN;
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 1500, 1000)).toBe(true);
  workspace.reset();
  expect(() => workspace.solve(input)).toThrow();
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 1500, 1000)).toBe(false);
});

it('validates the owned donor snapshot without rereading caller accessors', () => {
  const input = donor();
  let reads = 0;
  const changing = { get heightM() { return ++reads === 1 ? 3000 : 5000; }, temperatureC: 11 };
  input.levels = [input.levels[0]!, changing];
  const workspace = new ReconstructedProfileWorkspace(1, 2);
  expect(workspace.admit(0, input, 2)).toBe(true);
  expect(reads).toBe(1);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 3001, 1500)).toBe(false);
  expect(workspace.failure).toBe('unsupportedHeight');
});

it('rejects reentrant admission, reset, reconstruction, and solve during donor snapshot', () => {
  const valid = donor(), workspace = new ReconstructedProfileWorkspace(1, 3);
  const slots = Uint32Array.of(0), weights = Float64Array.of(1);
  let checkedHeight = false, checkedTemperature = false;
  const input = { ...valid, levels: [{
    get heightM() {
      expect(() => workspace.admit(0, valid, 1)).toThrow('Donor admission is in progress');
      expect(() => workspace.reset()).toThrow('Donor admission is in progress');
      checkedHeight = true;
      return 3500;
    },
    get temperatureC() {
      expect(() => workspace.reconstruct(slots, weights, 0, 1, 1500, 1500)).toThrow('Donor admission is in progress');
      expect(() => workspace.solve(valid)).toThrow('Donor admission is in progress');
      checkedTemperature = true;
      return 14;
    }
  }] };
  expect(workspace.admit(0, input, 1)).toBe(false);
  expect(checkedHeight && checkedTemperature).toBe(true);
  expect(workspace.reconstruct(slots, weights, 0, 1, 1500, 1500)).toBe(false);
  expect(workspace.admit(0, valid, 3)).toBe(true);
  const throwing = { ...valid, levels: [{ get heightM(): number { throw new Error('caller failed'); }, temperatureC: 14 }] };
  expect(() => workspace.admit(0, throwing, 1)).toThrow('caller failed');
  expect(workspace.reconstruct(slots, weights, 0, 1, 1500, 1500)).toBe(false);
  expect(workspace.admit(0, valid, 3)).toBe(true);
  expect(workspace.reconstruct(slots, weights, 0, 1, 1500, 1500)).toBe(true);
});

it('accepts physically positive synthetic temperatures beyond native observation bounds', () => {
  const input = donor();
  input.levels = [{ heightM: 2500, temperatureC: 60 }, { heightM: 3000, temperatureC: 58 }, { heightM: 3500, temperatureC: 56 }];
  const workspace = new ReconstructedProfileWorkspace(1, 3);
  expect(workspace.admit(0, input, 3)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 0, 1500)).toBe(true);
  expect(workspace.environmentAtGroundC).toBeGreaterThan(60);
  expect(workspace.solve({ surfaceTemperatureC: 50, surfacePressureHpa: 1000,
    humidity: { specificHumidityKgKg: 0.001 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 }).status).not.toBe('unavailable');
  expect(deriveLift({ ...input, levels: [{ heightM: 2500, temperatureC: 61 }] }, 1).status).toBe('unavailable');
});

it('merges distinct donor heights exactly, preserving an inversion', () => {
  const a = { ...donor(), terrainM: 0, levels: [{ heightM: 100, temperatureC: 18 },
    { heightM: 400, temperatureC: 19 }, { heightM: 700, temperatureC: 15 }] };
  const b = { ...donor(), terrainM: 0, levels: [{ heightM: 200, temperatureC: 17 },
    { heightM: 400, temperatureC: 19 }, { heightM: 800, temperatureC: 14 }] };
  const workspace = new ReconstructedProfileWorkspace(2, 3);
  expect(workspace.admit(0, a, 3)).toBe(true);
  expect(workspace.admit(1, b, 3)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, 0, 1000)).toBe(true);
  expect(workspace.levelCount).toBe(4);
  const result = workspace.solve({ surfaceTemperatureC: 20, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(result.branch).toBe('parcel-crossing');
  expect(result.depthM).toBeGreaterThan(100);
  expect(result.depthM).toBeLessThan(400);
});

it('distinguishes neutral and lowest-layer valley extrapolation', () => {
  const workspace = new ReconstructedProfileWorkspace(1, 3);
  expect(workspace.admit(0, donor(), 3)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 500, 1000, 'neutral')).toBe(true);
  const neutral = workspace.environmentAtGroundC;
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 500, 1000, 'lowest-layer')).toBe(true);
  expect(neutral - workspace.environmentAtGroundC).toBeCloseTo(3.8, 10);
});

it('refreshes admitted lapse rates for one-level, clamped and failed donors', () => {
  const input = donor(), workspace = new ReconstructedProfileWorkspace(1, 3);
  const slots = Uint32Array.of(0), weights = Float64Array.of(1);
  const check = (levels: ColumnInput['levels'], lapse: number) => {
    expect(workspace.admit(0, { ...input, levels }, levels.length)).toBe(true);
    expect(workspace.reconstruct(slots, weights, 0, 1, 1400, 1000, 'lowest-layer')).toBe(true);
    expect(workspace.environmentAtGroundC).toBe(levels[0]!.temperatureC + lapse * (levels[0]!.heightM - 1500) + lapse * 100);
  };
  check(input.levels, 0.006);
  check([{ heightM: 2500, temperatureC: 14 }], 0.0098);
  check([{ heightM: 2500, temperatureC: 14 }, { heightM: 3000, temperatureC: 16 }], 0);
  check([{ heightM: 2500, temperatureC: 14 }, { heightM: 3000, temperatureC: 4 }], 0.0098);
  expect(workspace.admit(0, { ...input, levels: [{ heightM: 2500, temperatureC: NaN }] }, 1)).toBe(false);
  expect(workspace.reconstruct(slots, weights, 0, 1, 1400, 1000)).toBe(false);
  check(input.levels, 0.006);
  workspace.reset();
  expect(workspace.reconstruct(slots, weights, 0, 1, 1400, 1000)).toBe(false);
});

it('requires all donors at the bridge endpoint and the lowest donor top', () => {
  const a = { ...donor(), terrainM: 0, levels: [{ heightM: 500, temperatureC: 17 },
    { heightM: 1000, temperatureC: 14 }, { heightM: 1500, temperatureC: 11 }] };
  const b = { ...donor(), terrainM: 0, levels: [{ heightM: 500, temperatureC: 17 },
    { heightM: 1000, temperatureC: 14 }, { heightM: 1800, temperatureC: 10 }] };
  const workspace = new ReconstructedProfileWorkspace(2, 3);
  expect(workspace.admit(0, a, 3)).toBe(true);
  expect(workspace.admit(1, b, 3)).toBe(true);
  const slots = Uint32Array.of(0, 1), weights = Float64Array.of(0.5, 0.5);
  expect(workspace.reconstruct(slots, weights, 0, 2, -1000, 1000)).toBe(true);
  expect(workspace.reconstruct(slots, weights, 0, 2, -1000.01, 1000)).toBe(false);
  expect(workspace.failure).toBe('belowGroundBridgeExceeded');
  expect(workspace.reconstruct(slots, weights, 0, 2, 1499, 1000)).toBe(true);
  expect(workspace.reconstruct(slots, weights, 0, 2, 1500, 1000)).toBe(false);
  expect(workspace.failure).toBe('unsupportedHeight');
});

it('rejects native out-of-range observations even when the flux is nonpositive', () => {
  const input = donor();
  input.sensibleHeatFluxWm2 = -100;
  input.levels = [{ heightM: 2500, temperatureC: 61 }];
  const workspace = new ReconstructedProfileWorkspace(1, 1);
  expect(deriveLift(input, 1).status).toBe('unavailable');
  expect(workspace.admit(0, input, 1)).toBe(false);
});

it('exposes admitted donor top and depth at the fine terrain', () => {
  const workspace = new ReconstructedProfileWorkspace(2, 3);
  expect(workspace.admit(0, donor(), 3)).toBe(true);
  expect(workspace.admit(1, { ...donor(), terrainM: 500 }, 3)).toBe(false);
  const second = { ...donor(), terrainM: 1000, levels: [
    { heightM: 1500, temperatureC: 19 }, { heightM: 2000, temperatureC: 16 }, { heightM: 2500, temperatureC: 13 }
  ] };
  expect(workspace.admit(1, second, 3)).toBe(true);
  const slots = Uint32Array.of(0, 1), weights = Float64Array.of(0.5, 0.5);
  expect(workspace.reconstruct(slots, weights, 0, 2, 0, 1000)).toBe(true);
  expect(workspace.minimumDonorTopM).toBe(2500);
  expect(workspace.maximumBelowGroundDepthM).toBe(1500);
  workspace.reset();
  expect(workspace.maximumBelowGroundDepthM).toBeNaN();
  expect(workspace.minimumDonorTopM).toBeNaN();
});

it('renormalizes supported donors while retaining the lowest original donor top', () => {
  const low = { ...donor(), terrainM: 0, levels: [
    { heightM: 500, temperatureC: 17 }, { heightM: 1000, temperatureC: 14 }, { heightM: 1500, temperatureC: 11 }
  ] };
  const high = { ...donor(), terrainM: 2000, levels: [
    { heightM: 2500, temperatureC: 17 }, { heightM: 3000, temperatureC: 14 }, { heightM: 3500, temperatureC: 11 }
  ] };
  const workspace = new ReconstructedProfileWorkspace(2, 3);
  expect(workspace.admit(0, low, 3)).toBe(true);
  expect(workspace.admit(1, high, 3)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 0, 1000)).toBe(true);
  expect(workspace.maximumBelowGroundDepthM).toBe(0);
  for (const epsilon of [1e-3, 1e-6, 1e-9]) {
    expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(1 - epsilon, epsilon), 0, 2, 0, 1000)).toBe(true);
    expect(workspace.groundEnvironmentWeight(0, 1 - epsilon)).toBeCloseTo(1, 12);
    expect(workspace.groundEnvironmentWeight(1, epsilon)).toBe(0);
    expect(workspace.maximumBelowGroundDepthM).toBe(2000);
    expect(workspace.minimumDonorTopM).toBe(1500);
    expect(workspace.reconstruct(Uint32Array.of(1), Float64Array.of(1), 0, 1, 2000, 1000)).toBe(true);
    expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(epsilon, 1 - epsilon), 0, 2, 2000, 1000)).toBe(false);
    expect(workspace.failure).toBe('unsupportedHeight');
  }
});

it('crosses an entering donor jump at its height instead of ramping toward it', () => {
  const low = { ...donor(), terrainM: 0, surfaceTemperatureC: 21, levels: [
    { heightM: 500, temperatureC: 15.1 }, { heightM: 1000, temperatureC: 10.2 },
    { heightM: 1500, temperatureC: 5.3 }, { heightM: 2000, temperatureC: 0.4 }
  ] };
  const high = { ...donor(), terrainM: 2000, levels: [
    { heightM: 2500, temperatureC: 20 }, { heightM: 3000, temperatureC: 17 },
    { heightM: 3500, temperatureC: 14 }, { heightM: 4000, temperatureC: 11 }
  ] };
  const workspace = new ReconstructedProfileWorkspace(2, 4);
  expect(workspace.byteLength).toBe(2 * (4 * 16 + 36) + 4 * (4 + 3) * 58 + 4);
  expect(deriveLift({ ...low, levels: [low.levels[0]!, low.levels[0]!] }, 2).status).toBe('unavailable');
  expect(workspace.admit(0, { ...low, levels: [low.levels[0]!, low.levels[0]!] }, 2)).toBe(false);
  expect(workspace.admit(0, low, 4)).toBe(true);
  expect(workspace.admit(1, high, 4)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, 0, 1000)).toBe(true);
  expect(workspace.groundEnvironmentWeight(0, 0.5)).toBe(1);
  expect(workspace.groundEnvironmentWeight(1, 0.5)).toBe(0);
  const result = workspace.solve({ surfaceTemperatureC: 21, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(result.branch).toBe('parcel-crossing');
  expect(result.depthM).toBe(1000);
  const neutral = workspace.solve({ surfaceTemperatureC: 20, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(neutral.branch).toBe('parcel-crossing');
  expect(neutral.depthM).toBe(1000);
  expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, 999.999, 1000)).toBe(true);
  expect(workspace.environmentAtGroundC).toBeCloseTo(10.2000098, 7);
  expect(workspace.groundEnvironmentWeight(1, 0.5)).toBe(0);
  expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, 1000, 1000)).toBe(true);
  expect(workspace.environmentAtGroundC).toBeCloseTo(21.5, 8);
  expect(workspace.groundEnvironmentWeight(1, 0.5)).toBe(0.5);
  const stableAtEntry = workspace.solve({ surfaceTemperatureC: 20.5, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(stableAtEntry.branch).toBe('surface-stable');
  expect(stableAtEntry.depthM).toBe(0);
  low.levels = [
    { heightM: 500, temperatureC: 15 }, { heightM: 1000, temperatureC: 12 },
    { heightM: 1500, temperatureC: 5.3 }, { heightM: 2000, temperatureC: 0.4 }
  ];
  expect(workspace.admit(0, low, 4)).toBe(true);
  expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, 0, 1000)).toBe(true);
  const beforeJump = workspace.solve({ surfaceTemperatureC: 21, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 });
  expect(beforeJump.branch).toBe('parcel-crossing');
  expect(beforeJump.depthM).toBeCloseTo(789.473684, 4);
});

it('reuses sorted donor knots without changing reconstruction across active sets and support entries', () => {
  const inputs = [
    { ...donor(), terrainM: 0, levels: [{ heightM: 500, temperatureC: 17 }, { heightM: 1000, temperatureC: 14 }, { heightM: 1500, temperatureC: 11 }] },
    { ...donor(), terrainM: 2000, levels: [{ heightM: 2500, temperatureC: 17 }, { heightM: 3000, temperatureC: 14 }, { heightM: 3500, temperatureC: 11 }] }
  ];
  const reused = new ReconstructedProfileWorkspace(2, 3);
  for (let i = 0; i < 2; i++) expect(reused.admit(i, inputs[i]!, 3)).toBe(true);
  const solve = { surfaceTemperatureC: 21, surfacePressureHpa: 900,
    humidity: { specificHumidityKgKg: 0.005 }, sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 };
  const cases = [
    { slots: [0, 1], weights: [0.75, 0.25], height: 0, bridge: 1000 },
    { slots: [0, 1], weights: [0.5, 0.5], height: 999.999, bridge: 1000 },
    { slots: [0, 1], weights: [0.25, 0.75], height: 1000, bridge: 1000 },
    { slots: [0, 1], weights: [0.5, 0.5], height: -1001, bridge: 1000 },
    { slots: [0, 1], weights: [0.5, 0.5], height: 500, bridge: 1500 },
    { slots: [0], weights: [1], height: 1000, bridge: 1000 },
    { slots: [1], weights: [1], height: 2000, bridge: 1000 },
    { slots: [0, 1], weights: [0.5, 0.5], height: 1499, bridge: 1000 }
  ];
  for (const item of cases) {
    const fresh = new ReconstructedProfileWorkspace(2, 3);
    for (let i = 0; i < 2; i++) expect(fresh.admit(i, inputs[i]!, 3)).toBe(true);
    const slots = Uint32Array.from(item.slots), weights = Float64Array.from(item.weights);
    const expected = fresh.reconstruct(slots, weights, 0, slots.length, item.height, item.bridge);
    expect(reused.reconstruct(slots, weights, 0, slots.length, item.height, item.bridge)).toBe(expected);
    expect(reused.failure).toBe(fresh.failure);
    expect(reused.maximumBelowGroundDepthM).toBe(fresh.maximumBelowGroundDepthM);
    if (expected) {
      expect(reused.levelCount).toBe(fresh.levelCount);
      expect(reused.environmentAtGroundC).toBe(fresh.environmentAtGroundC);
      expect(reused.surfaceEnvironmentAtGroundC).toBe(fresh.surfaceEnvironmentAtGroundC);
      expect(reused.solve(solve)).toEqual(fresh.solve(solve));
    }
  }
  reused.reset();
  expect(reused.admit(0, inputs[0]!, 3)).toBe(true);
  expect(reused.reconstruct(Uint32Array.of(0), Float64Array.of(1), 0, 1, 0, 1000)).toBe(true);
});

it('matches reference knot temperatures and support across bridge modes', () => {
  const workspace = new ReconstructedProfileWorkspace(2, 3);
  for (let i = 0; i < 2; i++) expect(workspace.admit(i, { ...donor(), terrainM: i * 2000,
    levels: [500, 1000, 1500].map((heightM, j) => ({ heightM: i * 2000 + heightM, temperatureC: 17 - j * 3 })) }, 3)).toBe(true);
  const solve = { surfaceTemperatureC: 21, surfacePressureHpa: 900, humidity: { specificHumidityKgKg: 0.005 },
    sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 };
  const cases = [
    { height: 0, bridge: 1000, mode: 'neutral' as const, levels: 4, ground: 20, surface: 20,
      result: { status: 'valid', usableDepthM: 243.10541761262942, branch: 'parcel-crossing', depthM: 263.1578947368423, thermalVelocityMps: 1.180380467927981 } },
    { height: 1000, bridge: 1000, mode: 'neutral' as const, levels: 1, ground: 21.9, surface: 18.633333333333333,
      result: { status: 'no-lift', usableDepthM: 0, branch: 'surface-stable', depthM: 0, thermalVelocityMps: 0 } },
    { height: 1001, bridge: 1000, mode: 'neutral' as const, levels: 1, ground: 21.8921, surface: 18.62978852568379,
      result: { status: 'no-lift', usableDepthM: 0, branch: 'surface-stable', depthM: 0, thermalVelocityMps: 0 } },
    { height: 1001, bridge: 1000, mode: 'lowest-layer' as const, levels: 1, ground: 19.994, surface: 17.996666444296196,
      result: { status: 'valid', usableDepthM: 244.7589598786603, branch: 'parcel-crossing', depthM: 264.7368421052632, thermalVelocityMps: 1.1827365230176934 } },
    { height: 500, bridge: 1500, mode: 'lowest-layer' as const, levels: 2, ground: 23, surface: 20,
      result: { status: 'no-lift', usableDepthM: 0, branch: 'surface-stable', depthM: 0, thermalVelocityMps: 0 } }
  ];
  for (const item of cases) {
    expect(workspace.reconstruct(Uint32Array.of(0, 1), Float64Array.of(0.5, 0.5), 0, 2, item.height, item.bridge, item.mode)).toBe(true);
    expect(workspace.levelCount).toBe(item.levels);
    expect(workspace.environmentAtGroundC).toBe(item.ground);
    expect(workspace.surfaceEnvironmentAtGroundC).toBe(item.surface);
    expect(workspace.solve(solve)).toEqual(item.result);
  }
});

it.each(['neutral', 'lowest-layer'] as const)('shares quad knot rows without adding inactive donor knots in %s mode', mode => {
  const inputs = Array.from({ length: 4 }, (_, i) => ({ ...donor(), terrainM: i * 100,
    levels: [500, 1000, 1500].map((heightM, j) => ({ heightM: heightM + i * 100, temperatureC: 17 - j * 3 + i })) }));
  const sets = [[0, 1, 2, 3], [0, 1], [0, 2], [0]];
  const solve = { surfaceTemperatureC: 21, surfacePressureHpa: 900, humidity: { specificHumidityKgKg: 0.005 },
    sensibleHeatFluxWm2: 200, latentHeatFluxWm2: 0 };
  const run = (workspace: ReconstructedProfileWorkspace, set: number[]) => {
    expect(workspace.reconstruct(Uint32Array.from(set), new Float64Array(set.length).fill(1 / set.length), 0, set.length, 0, 1000, mode)).toBe(true);
    return { levels: workspace.levelCount, ground: workspace.environmentAtGroundC, surface: workspace.surfaceEnvironmentAtGroundC,
      result: workspace.solve(solve) };
  };
  const make = () => {
    const workspace = new ReconstructedProfileWorkspace(4, 3);
    for (let i = 0; i < 4; i++) expect(workspace.admit(i, inputs[i]!, 3)).toBe(true);
    return workspace;
  };
  const expected = sets.map(set => run(make(), set));
  const reused = make(), sort = vi.spyOn(Float64Array.prototype, 'sort');
  try {
    expect(sets.map(set => run(reused, set))).toEqual(expected);
    expect(sort).toHaveBeenCalledTimes(1);
  } finally {
    sort.mockRestore();
  }
});
