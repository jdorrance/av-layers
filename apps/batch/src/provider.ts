import z from 'zod';
import { MAX_MANIFEST_BYTES } from '@av/contracts';
import type { ObjectStorage } from './storage.js';
import type { AuxField, AuxSurfaceId, AuxLevelId, AuxSurface, AuxLevels, NormalizedFrame } from '@av/forecast/inputs';

export type NormalizedFrameTarget = Pick<NormalizedFrame, 'terrainM' | 'surfacePressurePa' | 'temp2mK' | 'specificHumidity2mKgKg' | 'sensibleHeatFluxWm2' | 'latentHeatFluxWm2' | 'precipitationMmPerHour' | 'hgtM' | 'tempK' | 'pressurePa' | 'missing' | 'auxSurface' | 'auxLevels'>;

/** Allocate only configured channels; a caller's ring slot retains shared buffers. */
export function createAuxiliaryTargets(cells: number, levels: number, surfaceIds: readonly AuxSurfaceId[], levelIds: readonly AuxLevelId[], target?: NormalizedFrameTarget): { auxSurface: AuxSurface; auxLevels: AuxLevels } {
  const field = (): AuxField => ({ values: new Float32Array(target ? new SharedArrayBuffer(cells * 4) : new ArrayBuffer(cells * 4)),
    missing: new Uint8Array(target ? new SharedArrayBuffer(cells) : new ArrayBuffer(cells)) });
  const auxSurface: AuxSurface = {}, auxLevels: AuxLevels = {};
  for (const id of surfaceIds) auxSurface[id] = target?.auxSurface?.[id] ?? field();
  for (const id of levelIds) auxLevels[id] = target?.auxLevels?.[id] ?? Array.from({ length: levels }, field);
  if (target) { target.auxSurface = auxSurface; target.auxLevels = auxLevels; }
  return { auxSurface, auxLevels };
}

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
export const forecastSourcePinSchema = z.strictObject({ key: z.string().min(1).max(1024), bytes: z.number().int().positive().max(MAX_MANIFEST_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export type ForecastSourcePin = z.infer<typeof forecastSourcePinSchema>;
export type ForecastSourceStore = Pick<ObjectStorage, 'get' | 'head'>;
interface ForecastRunOptions { cycle?: string; cacheDir: string; signal?: AbortSignal; store?: ForecastSourceStore }

export interface ForecastProvider {
  id: string;
  provider: string;
  maxLevels: number;
  directTargets?: boolean;
  /** Cached Float32 value/Uint8 mask pairs retained alongside each normalized frame. */
  retainedGeometryFields?: number;
  auxiliarySurfaceFields?: number;
  auxiliaryLevelFields?: number;
  resolveRun?(options: ForecastRunOptions): Promise<{ cycle: string; sourcePin: ForecastSourcePin }>;
  open(options: ForecastRunOptions & { activeIndices: Uint32Array; sourcePin?: ForecastSourcePin; readOnlyCache?: boolean; offline?: boolean }): Promise<ForecastSession>;
}

export type ResolvableForecastProvider = ForecastProvider & {
  resolveCycle(options: ForecastRunOptions): Promise<string>;
  proveInputs(options: Omit<ForecastRunOptions, 'cacheDir'> & { cacheDir?: string }): Promise<unknown>;
};
