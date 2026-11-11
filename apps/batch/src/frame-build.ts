import type { CoverageMask, ManifestV5, ProductDefinition } from '@av/contracts';
import type { DeriveFrameOptions } from '@av/forecast';
import type { ForecastProvider, ForecastSourcePin, ForecastSourceStore } from './provider.js';

export interface FrameBuildOptions {
  out: string;
  cycle?: string;
  cacheDir?: string;
  signal?: AbortSignal;
  sourceStore?: ForecastSourceStore;
  sourcePin?: ForecastSourcePin;
  deriveOptions?: Pick<DeriveFrameOptions, 'daylightOnly'>;
}
export interface ForecastInputs { product: ProductDefinition; mask: CoverageMask; provider: ForecastProvider }
export interface BuildStamp { buildId: string; createdAt: string }

export function forecastFrame(cycle: string, hour: number, intervalHours: number): ManifestV5['frames'][number] {
  const start = new Date(Date.parse(cycle) + (hour - intervalHours) * 3_600_000).toISOString();
  const end = new Date(Date.parse(cycle) + hour * 3_600_000).toISOString();
  return { id: `f${String(hour).padStart(3, '0')}`, validTime: end, intervalStart: start, intervalEnd: end };
}
