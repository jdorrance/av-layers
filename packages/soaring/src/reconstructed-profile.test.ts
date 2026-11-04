import { expect, it } from 'vitest';
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
  expect(workspace.byteLength).toBe(2 * (4 * 16 + 28) + 4 * (4 + 3) * 24);
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
