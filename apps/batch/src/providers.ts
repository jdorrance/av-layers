import { getProduct, GFS_PRODUCT } from '@av/contracts';
import type { NormalizedFrame } from '@av/forecast';
import { createGfsAcquisitionSession, discoverGfsRun } from './noaa/index.js';
import { validateCycle } from './noaa/acquire.js';
import { GFS_PRESSURE_LEVELS_HPA } from './noaa/constants.js';

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
  resolveCycle?(options: { cycle?: string; cacheDir: string; signal?: AbortSignal }): Promise<string>;
  open(options: { cycle?: string; activeIndices: Uint32Array; cacheDir: string; signal?: AbortSignal }): Promise<ForecastSession>;
}

/** NOAA inventory, GRIB encoding and source-grid details terminate at this adapter. */
export const gfsProvider: ForecastProvider & {
  resolveCycle(options: { cycle?: string; cacheDir: string; signal?: AbortSignal }): Promise<string>;
} = {
  id: GFS_PRODUCT.source.configurationId, provider: 'NOAA', maxLevels: GFS_PRESSURE_LEVELS_HPA.length,
  async resolveCycle(options) {
    options.signal?.throwIfAborted();
    return validateCycle(options.cycle ?? (await discoverGfsRun(options)).cycle);
  },
  async open(options) {
    const session = await createGfsAcquisitionSession(options);
    return {
      cycle: session.cycle, get stats() { return { ...session.stats }; },
      acquire: hour => session.acquire(hour), close: () => session.close()
    };
  }
};

/** Explicit production binding; test providers are passed directly to buildForecast. */
export function getForecastProvider(modelId: string): typeof gfsProvider {
  const product = getProduct(modelId);
  if (!product || product.source.configurationId !== gfsProvider.id) throw new Error(`No forecast provider for ${modelId}`);
  return gfsProvider;
}
