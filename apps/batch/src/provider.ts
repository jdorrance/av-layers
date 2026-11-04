import type { NormalizedFrame } from '@av/forecast/inputs';

export type NormalizedFrameTarget = Pick<NormalizedFrame, 'terrainM' | 'surfacePressurePa' | 'temp2mK' | 'specificHumidity2mKgKg' | 'sensibleHeatFluxWm2' | 'latentHeatFluxWm2' | 'precipitationMmPerHour' | 'hgtM' | 'tempK' | 'pressurePa' | 'missing'>;

export function createNormalizedFrameTarget(cells: number, levels: number, modelLevels: boolean, precipitation: boolean): NormalizedFrameTarget {
  const values = () => new Float32Array(new SharedArrayBuffer(cells * 4));
  const flags = () => new Uint8Array(new SharedArrayBuffer(cells));
  const hgtM = Array.from({ length: levels }, values), tempK = Array.from({ length: levels }, values);
  const missing = { terrain: flags(), surfacePressure: flags(), temp2m: flags(), humidity2m: flags(), sensibleHeatFlux: flags(), latentHeatFlux: flags(),
    ...(precipitation ? { precipitation: flags() } : {}), hgt: Array.from({ length: levels }, flags), temp: Array.from({ length: levels }, flags),
    ...(modelLevels ? { pressure: Array.from({ length: levels }, flags) } : {}) };
  return { terrainM: values(), surfacePressurePa: values(), temp2mK: values(), specificHumidity2mKgKg: values(), sensibleHeatFluxWm2: values(), latentHeatFluxWm2: values(),
    ...(precipitation ? { precipitationMmPerHour: values() } : {}), hgtM, tempK,
    ...(modelLevels ? { pressurePa: Array.from({ length: levels }, values) } : {}), missing } as NormalizedFrameTarget;
}

export interface ForecastSession {
  cycle: string;
  readonly stats: Record<string, unknown>;
  /** Acquire sequentially; the caller owns each returned frame and closes the session in finally. */
  acquire(hour: number, target?: NormalizedFrameTarget): Promise<NormalizedFrame>;
  close(): Promise<void>;
}
export interface ForecastProvider {
  id: string;
  provider: string;
  maxLevels: number;
  directTargets?: boolean;
  /** Cached Float32 value/Uint8 mask pairs retained alongside each normalized frame. */
  retainedGeometryFields?: number;
  open(options: { cycle?: string; activeIndices: Uint32Array; cacheDir: string; signal?: AbortSignal; readOnlyCache?: boolean; offline?: boolean }): Promise<ForecastSession>;
}

export type ResolvableForecastProvider = ForecastProvider & {
  resolveCycle(options: { cycle?: string; cacheDir: string; signal?: AbortSignal }): Promise<string>;
  proveInputs(options: { cycle?: string; cacheDir?: string; signal?: AbortSignal }): Promise<unknown>;
};
