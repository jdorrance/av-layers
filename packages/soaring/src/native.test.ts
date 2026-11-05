import { describe, expect, it } from 'vitest';
import { deriveLift, deriveNativeColumnDiagnostics, deriveSoaringViews, nativeColumnWindAtHeight, nativeColumnCloudDiagnostics, type NativeDiagnosticInput, type NativeDiagnosticLevel } from './index.js';
import { boltonLclHeightMetersAgl, dewPointFromMixingRatioC, mixingRatioFromDewPointKgKg } from '@av/thermodynamics';
import { deriveCloudRegime } from './views.js';

const column = (): NativeDiagnosticInput & { levels: NativeDiagnosticLevel[] } => ({
  terrainM: 100, surfaceTemperatureC: 25, surfaceDewPointC: 12, surfacePressureHpa: 990,
  sensibleHeatFluxWm2: 8, latentHeatFluxWm2: 0, wind10mU: 0, wind10mV: -4,
  levels: [
    { heightM: 200, temperatureC: 23, dewPointC: 12, pressureHpa: 975, uMps: 0, vMps: -5 },
    { heightM: 600, temperatureC: 19.1, dewPointC: 9, pressureHpa: 925, uMps: 2, vMps: -6 },
    { heightM: 1100, temperatureC: 16.2, dewPointC: 4, pressureHpa: 850, uMps: 4, vMps: -8 },
  ]
});

describe('native diagnostics', () => {
  it('retains resolved depth and positive convection below the map sink threshold', () => {
    const input = column(), out = deriveNativeColumnDiagnostics(input);
    expect(out.thermalDepthM).toBeCloseTo(750);
    expect(out.thermalTopM).toBeCloseTo(850);
    expect(out.thermalVelocityMps).toBeGreaterThan(0);
    const fine = deriveLift({ ...input, surfacePressureHpa: 990, sensibleHeatFluxWm2: 8, latentHeatFluxWm2: 0, humidity: { dewPointC: 12 } }, 3);
    expect(fine.status).toBe('no-lift');
    expect(out.thermalVelocityMps).toBeCloseTo(fine.thermalVelocityMps!);
    const views = deriveSoaringViews({ ...out, terrainM: 100 });
    expect(views.usableLiftTopV2M).toBeGreaterThan(100);
    expect(views.hcritWxtoflyM).toBeNull();
  });

  it('keeps independent LCL and layer wind when heat flux is missing', () => {
    const input = column(); delete input.sensibleHeatFluxWm2;
    const out = deriveNativeColumnDiagnostics(input);
    expect(out.thermalTopM).toBeCloseTo(850);
    expect(out.thermalVelocityMps).toBeNull();
    expect(out.surfaceLclM).toBeGreaterThan(100);
    expect(out.mixedLayerLclM).toBeGreaterThan(100);
    expect(out.blMeanWindV).toBeLessThan(0);
    expect(deriveSoaringViews({ ...out, terrainM: 100 }).usableLiftTopV2M).toBeNull();
  });

  it('distinguishes known non-convection from an unknown shallow-layer closure', () => {
    const input = column(); input.levels[0] = { ...input.levels[0], temperatureC: 26 };
    const stable = deriveNativeColumnDiagnostics({ ...input, sensibleHeatFluxWm2: 0, latentHeatFluxWm2: 0 });
    expect(stable.thermalDepthM).toBe(0); expect(stable.thermalVelocityMps).toBe(0);
    expect(stable.thermalTopM).toBe(input.terrainM);
    expect(stable.blTopWindV).toBe(-4);
    const missing = deriveNativeColumnDiagnostics({ ...input, sensibleHeatFluxWm2: undefined });
    expect(missing.thermalDepthM).toBeNull(); expect(missing.thermalVelocityMps).toBeNull();
    expect(missing.blTopWindV).toBeNull();
  });

  it('clips vector and pressure-mass integrals to a shallow model PBL', () => {
    const input: NativeDiagnosticInput = {
      terrainM: 0, surfaceTemperatureC: 20, surfaceDewPointC: 10, surfacePressureHpa: 1000,
      sensibleHeatFluxWm2: 100, latentHeatFluxWm2: 0, pblHeightM: 100, wind10mU: 0, wind10mV: 10,
      levels: [500, 1000, 1500].map((heightM, i) => ({ heightM, temperatureC: 18 - i * 4, dewPointC: 8 - i * 4, pressureHpa: 940 - i * 60, uMps: 10, vMps: 0 }))
    };
    const out = deriveNativeColumnDiagnostics(input);
    expect(out.depthBranch).toBe('model-pbl-fallback'); expect(out.thermalTopM).toBe(100);
    expect(out.blTopWindU).toBeCloseTo(2); expect(out.blTopWindV).toBeCloseTo(8);
    expect(out.blMeanWindU).toBeCloseTo(1); expect(out.blMeanWindV).toBeCloseTo(9);
    const pTop = 1000 * (940 / 1000) ** 0.2, fraction = (1000 - pTop) / 60;
    const thetaSurface = 293.15, thetaLevel = 291.15 * (1000 / 940) ** 0.2854;
    const mixedT = thetaSurface + 0.5 * fraction * (thetaLevel - thetaSurface) - 273.15;
    const rSurface = mixingRatioFromDewPointKgKg(10, 1000), rLevel = mixingRatioFromDewPointKgKg(8, 940);
    const mixedTd = dewPointFromMixingRatioC(rSurface + 0.5 * fraction * (rLevel - rSurface), 1000);
    expect(out.mixedLayerLclM).toBeCloseTo(boltonLclHeightMetersAgl(mixedT, mixedTd), 8);
  });

  it('does not bridge missing wind or moisture inside the integration layer', () => {
    const input = column(); input.levels[1] = { ...input.levels[1], dewPointC: null, uMps: null };
    const out = deriveNativeColumnDiagnostics(input);
    expect(out.mixedLayerLclM).toBeNull(); expect(out.blMeanWindU).toBeNull();
    expect(out.thermalTopM).toBeCloseTo(850); expect(out.surfaceLclM).not.toBeNull();
  });

  it('requires full layer support and rejects invalid level counts', () => {
    const input = column(); input.levels[2] = { ...input.levels[2], temperatureC: 10 };
    input.levels[1] = { ...input.levels[1], uMps: undefined };
    expect(deriveNativeColumnDiagnostics(input).blMeanWindU).toBeNull();
    expect(deriveNativeColumnDiagnostics(input, 1).thermalTopM).toBeNull();
    expect(() => deriveNativeColumnDiagnostics(input, 4)).toThrow(RangeError);
  });

  it('caps the cloud limit at a near-saturated ambient level', () => {
    const input = column(); input.levels[0] = { ...input.levels[0], dewPointC: 22.8 };
    expect(deriveNativeColumnDiagnostics(input).effectiveCloudLimitM).toBe(200);
  });

  it('skips night convection while retaining surface LCL and model-PBL winds', () => {
    const input = { ...column(), daylight: false, pblHeightM: 300 };
    delete input.sensibleHeatFluxWm2;
    const out = deriveNativeColumnDiagnostics(input);
    expect(out.thermalDepthM).toBe(0); expect(out.thermalTopM).toBe(100); expect(out.thermalVelocityMps).toBe(0);
    expect(out.surfaceLclM).toBeGreaterThan(100); expect(out.mixedLayerLclM).toBeGreaterThan(100);
    expect(out.blTopWindU).toBeCloseTo(1); expect(out.blTopWindV).toBeCloseTo(-5.5);
  });

  it('interpolates humidity at the thermal top and preserves a missing humidity bracket', () => {
    const input = column(), out = deriveNativeColumnDiagnostics(input);
    expect(out.thermalTopRhPercent).toBeGreaterThan(0); expect(out.thermalTopRhPercent).toBeLessThan(100);
    input.levels[0] = { ...input.levels[0], dewPointC: null };
    expect(deriveNativeColumnDiagnostics(input).thermalTopRhPercent).toBe(out.thermalTopRhPercent);
    input.levels[1] = { ...input.levels[1], dewPointC: null };
    expect(deriveNativeColumnDiagnostics(input).thermalTopRhPercent).toBeNull();
  });

  it('derives layer winds and cloud levels at an emitted top without resolving convection', () => {
    const input = column(); delete input.sensibleHeatFluxWm2;
    const wind = nativeColumnWindAtHeight(input, 400);
    expect(wind.blTopWindU).toBeCloseTo(1); expect(wind.blTopWindV).toBeCloseTo(-5.5);
    expect(wind.blMeanWindU).toBeCloseTo(1 / 3); expect(wind.blMeanWindV).toBeCloseTo(-5);
    const cloud = nativeColumnCloudDiagnostics(input, 400);
    expect(cloud.surfaceLclM).toBeGreaterThan(100); expect(cloud.mixedLayerLclM).toBeGreaterThan(100);
    expect(nativeColumnCloudDiagnostics(input, null).mixedLayerLclM).toBeNull();
    expect(nativeColumnCloudDiagnostics(input, null).surfaceLclM).toBe(cloud.surfaceLclM);
    expect(() => nativeColumnWindAtHeight(input, 400, 4)).toThrow(RangeError);
  });
});

describe('point views', () => {
  it('interpolates North as vector components and keeps calm direction absent', () => {
    const a = 350 * Math.PI / 180, b = 10 * Math.PI / 180;
    const out = deriveSoaringViews({ wind10mU: (-Math.sin(a) - Math.sin(b)) / 2, wind10mV: (-Math.cos(a) - Math.cos(b)) / 2, blMeanWindU: 0, blMeanWindV: 0 });
    expect(out.wind10mSpeedMps).toBeCloseTo(Math.cos(b)); expect(out.wind10mDirDeg).toBeCloseTo(0);
    expect(out.blMeanWindSpeedMps).toBe(0); expect(out.blMeanWindDirDeg).toBeNull();
  });

  it('rejects a cloud cap below the lower updraft crossing', () => {
    const input = { terrainM: 100, thermalTopM: 2100, thermalVelocityMps: 1, effectiveCloudLimitM: 101 };
    const out = deriveSoaringViews(input);
    expect(out.usableLiftTopV2M).toBeNull(); expect(out.dryHcritM).toBeGreaterThan(100);
    expect(out.cloudCapped).toBe(true);
    expect(deriveSoaringViews({ ...input, effectiveCloudLimitM: 800 }).usableLiftTopV2M).toBe(800);
  });

  it('keeps cloud, shear and buoyancy dependencies explicit', () => {
    const out = deriveSoaringViews({ thermalTopM: 2000, surfaceLclM: 1500, thermalVelocityMps: 1, wind10mU: 3, wind10mV: 4, blTopWindU: 6, blTopWindV: 8 });
    expect(out.cuPotentialM).toBe(500); expect(out.cumulus).toBe(true);
    expect(out.odPotentialM).toBeNull(); expect(out.overdeveloped).toBeNull();
    expect(out.blWindShearMps).toBe(5); expect(out.buoyancyShearRatio).toBe(0.2);
    expect(out.usableLiftTopV2M).toBeNull();
  });

  it('requires humid air at thermal top before marking overdevelopment', () => {
    const input = { thermalTopM: 2000, mixedLayerLclM: 1500, thermalVelocityMps: 1 };
    expect(deriveSoaringViews(input).overdeveloped).toBeNull();
    expect(deriveSoaringViews({ ...input, thermalTopRhPercent: 84 }).overdeveloped).toBe(false);
    expect(deriveSoaringViews({ ...input, thermalTopRhPercent: 85 }).overdeveloped).toBe(true);
    expect(deriveSoaringViews({ ...input, mixedLayerLclM: 2500 }).overdeveloped).toBe(false);
    expect(deriveSoaringViews({ ...input, thermalVelocityMps: 0, thermalTopRhPercent: 90 }).overdeveloped).toBe(false);
  });

  it('evaluates whole-grid cloud caps without solving each sink crossing', () => {
    for (const w of [0, 0.2, 0.5, 0.6, 1, 1.3, 3]) for (const cap of [-1, 0, 5, 100, 625, 1000, 1800, 1999, 2000, 2100]) {
      const basis = { terrainM: 0, thermalTopM: 2000, thermalVelocityMps: w, effectiveCloudLimitM: cap };
      const dry = deriveSoaringViews(basis).dryHcritM;
      expect(deriveCloudRegime(basis).cloudCapped).toBe(dry === null ? null : cap < dry);
    }
  });
});
