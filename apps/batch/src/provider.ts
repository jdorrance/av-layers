import type { NormalizedFrame } from '@av/forecast/inputs';

export interface ForecastSession {
  cycle: string;
  readonly stats: Record<string, unknown>;
  /** Acquire sequentially; the caller owns each returned frame and closes the session in finally. */
  acquire(hour: number): Promise<NormalizedFrame>;
  close(): Promise<void>;
}
export interface ForecastProvider {
  id: string;
  provider: string;
  maxLevels: number;
  /** Cached Float32 value/Uint8 mask pairs retained alongside each normalized frame. */
  retainedGeometryFields?: number;
  open(options: { cycle?: string; activeIndices: Uint32Array; cacheDir: string; signal?: AbortSignal; readOnlyCache?: boolean; offline?: boolean }): Promise<ForecastSession>;
}

export type ResolvableForecastProvider = ForecastProvider & {
  resolveCycle(options: { cycle?: string; cacheDir: string; signal?: AbortSignal }): Promise<string>;
  proveInputs(options: { cycle?: string; cacheDir?: string; signal?: AbortSignal }): Promise<unknown>;
};
