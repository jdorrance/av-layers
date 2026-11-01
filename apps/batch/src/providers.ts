import { GFS_GRID, type Grid } from '@av/contracts';
import { createGfsAcquisitionSession } from './noaa/index.js';

/** Provider-independent arrays in the declared field units, compacted to activeIndices; missingness is explicit. */
export interface NormalizedFrame {
  cycle: string; hour: number; validAt: string; capturedAt: string; grid: Grid;
  activeIndices: Uint32Array;
  terrainM: Float32Array; surfacePressurePa: Float32Array; temp2mK: Float32Array; specificHumidity2mKgKg: Float32Array;
  pblHeightM: Float32Array; sensibleHeatFluxWm2: Float32Array; latentHeatFluxWm2: Float32Array; precipitationMmPerHour: Float32Array;
  pressureLevelsHpa: readonly number[]; hgtM: Float32Array[]; tempK: Float32Array[];
  missing: {
    terrain: Uint8Array; surfacePressure: Uint8Array; temp2m: Uint8Array; humidity2m: Uint8Array;
    pbl: Uint8Array; sensibleHeatFlux: Uint8Array; latentHeatFlux: Uint8Array; precipitation: Uint8Array;
    hgt: Uint8Array[]; temp: Uint8Array[];
  };
  intervals: {
    profileTime: string; fluxWindow: { start: string; end: string }; precipitationWindow: { start: string; end: string };
    fluxSourceWindow: { start: string; end: string }; precipitationSourceWindow: { start: string; end: string }; usedCompanion: boolean;
  };
  receipt: Record<string, unknown>;
}
export interface ForecastSession {
  cycle: string;
  readonly stats: Record<string, unknown>;
  acquire(hour: number): Promise<NormalizedFrame>;
  close(): Promise<void>;
}
export interface ForecastProvider {
  id: string;
  provider: string;
  maxLevels: number;
  open(options: { cycle?: string; activeIndices: Uint32Array; cacheDir: string; signal?: AbortSignal }): Promise<ForecastSession>;
}

/** NOAA inventory, GRIB encoding and source-grid details terminate at this adapter. */
export const gfsProvider: ForecastProvider = {
  id: 'noaa-gfs-0p25', provider: 'NOAA', maxLevels: 37,
  async open(options) {
    if (options.cycle !== undefined && (!/^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00(?:\.000)?Z$/.test(options.cycle) || !Number.isFinite(Date.parse(options.cycle)) || new Date(options.cycle).toISOString().replace('.000Z', 'Z') !== options.cycle.replace('.000Z', 'Z'))) throw new Error('Cycle must be a valid GFS 00/06/12/18Z ISO UTC timestamp');
    const session = await createGfsAcquisitionSession(options);
    return {
      cycle: session.cycle, get stats() { return { ...session.stats }; },
      async acquire(hour) { return { ...await session.acquire(hour), grid: GFS_GRID }; },
      close: () => session.close()
    };
  }
};

export function validateNormalizedFrame(frame: NormalizedFrame, active: Uint32Array, grid: Grid, maxLevels: number): void {
  if (!(frame.activeIndices instanceof Uint32Array) || !active.length || JSON.stringify(frame.grid) !== JSON.stringify(grid) || frame.activeIndices.length !== active.length || frame.activeIndices.some((value, i) => value !== active[i])) throw new Error('Normalized input grid or active-index identity mismatch');
  const levels = frame.pressureLevelsHpa;
  if (!Array.isArray(levels) || !levels.length || !Number.isSafeInteger(maxLevels) || maxLevels < 1 || levels.length > maxLevels || levels.some((p, i) => !Number.isFinite(p) || p <= 0 || (i > 0 && p >= levels[i - 1]))) throw new Error('Unsupported normalized vertical axis');
  const fields = [frame.terrainM, frame.surfacePressurePa, frame.temp2mK, frame.specificHumidity2mKgKg, frame.pblHeightM, frame.sensibleHeatFluxWm2, frame.latentHeatFluxWm2, frame.precipitationMmPerHour];
  const missing = [frame.missing.terrain, frame.missing.surfacePressure, frame.missing.temp2m, frame.missing.humidity2m, frame.missing.pbl, frame.missing.sensibleHeatFlux, frame.missing.latentHeatFlux, frame.missing.precipitation];
  if ([frame.hgtM, frame.tempK, frame.missing.hgt, frame.missing.temp].some(values => !Array.isArray(values) || values.length !== levels.length)) throw new Error('Normalized input array dimensions mismatch');
  const allFields = [...fields, ...frame.hgtM, ...frame.tempK], allMissing = [...missing, ...frame.missing.hgt, ...frame.missing.temp];
  for (let field = 0; field < allFields.length; field++) {
    const values = allFields[field], flags = allMissing[field];
    if (!(values instanceof Float32Array) || !(flags instanceof Uint8Array) || values.length !== active.length || flags.length !== active.length) throw new Error('Normalized input array dimensions or types mismatch');
    for (let cell = 0; cell < active.length; cell++) if ((flags[cell] !== 0 && flags[cell] !== 1) || (flags[cell] === 0 && !Number.isFinite(values[cell]))) throw new Error('Normalized input has invalid missingness or unmasked nonfinite values');
  }
}
