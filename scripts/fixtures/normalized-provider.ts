import type { Grid } from '@av/contracts';
import type { NormalizedFrame } from '../../apps/batch/src/providers.js';

/** Deterministic SI values shared by native-grid integration tests and the offline preview. */
export function normalizedFixtureFrame(grid: Grid, activeIndices: Uint32Array, cycle: string, hour: number, intervalHours: number): NormalizedFrame {
  const values = (value: number) => new Float32Array(activeIndices.length).fill(value);
  const missing = () => new Uint8Array(activeIndices.length);
  const validAt = (offset: number) => new Date(Date.parse(cycle) + offset * 3600000).toISOString();
  const window = { start: validAt(hour - intervalHours), end: validAt(hour) };
  return {
    cycle, hour, validAt: validAt(hour), capturedAt: cycle, grid, activeIndices,
    terrainM: values(100), surfacePressurePa: values(100000), temp2mK: values(293.15), specificHumidity2mKgKg: values(0.008),
    pblHeightM: values(300), sensibleHeatFluxWm2: values(250), latentHeatFluxWm2: values(100),
    precipitationMmPerHour: Float32Array.from(activeIndices, index => hour + (index % grid.width) * 0.25 + Math.floor(index / grid.width) * 0.5),
    pressureLevelsHpa: [950, 900, 850], hgtM: [values(600), values(1100), values(1600)], tempK: [values(286.15), values(282.15), values(281.15)],
    missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), pbl: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing(), missing(), missing()], temp: [missing(), missing(), missing()] },
    intervals: { profileTime: validAt(hour), fluxWindow: window, precipitationWindow: window, fluxSourceWindow: window, precipitationSourceWindow: window, usedCompanion: false },
    receipt: { fixture: true, kind: 'analytic-normalized-column', source: 'No upstream model; infrastructure test only' }
  };
}
