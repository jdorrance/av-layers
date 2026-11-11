import { withinGeographicBounds } from '@av/contracts/geometry';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts/format';
import type { LayerId } from '@av/contracts/layers';
import { MODEL_OPTIONS } from '@av/contracts/model-options';
import { renderedFrames, type CatalogModelEntry } from '@av/contracts/publication';
import type { ApiClient } from './client-api.js';
import { selectHostFrame, type FrameLike } from './client-time.js';
import type { GeoPoint, PinnedBuild } from './client-types.js';

export const AUTO_MODEL_ID = 'auto';
export interface AutoForecastSelection { build: PinnedBuild; frame: FrameLike }

interface CatalogSelection extends GeoPoint {
  models: readonly CatalogModelEntry[];
  validTimeMs?: number;
  nowMs?: number;
}

function rankCatalogModels({ models, lat, lon, validTimeMs, nowMs = Date.now() }: CatalogSelection): CatalogModelEntry[] {
  const candidates = models.flatMap(model => {
    const published = MODEL_OPTIONS.find(option => option.modelId === model.model);
    const bounds = model.bounds ?? published?.bounds, spacing = model.nominalDxMeters ?? published?.nominalDxMeters;
    const expiresAt = model.expiresAt ?? model.freshness?.expiresAt;
    if (!model.available || model.model === AUTO_MODEL_ID || !bounds || spacing === undefined || !(spacing > 0) ||
      !Number.isFinite(spacing) || !withinGeographicBounds(lat, lon, bounds) ||
      (expiresAt !== undefined && !(Date.parse(expiresAt) > nowMs))) return [];
    const earliest = model.freshness?.earliestValidTime, latest = model.freshness?.latestValidTime;
    if (validTimeMs !== undefined && ((earliest !== undefined && !(validTimeMs >= Date.parse(earliest))) ||
      (latest !== undefined && !(validTimeMs <= Date.parse(latest))))) return [];
    if (validTimeMs === undefined && model.freshness?.horizonExhausted) return [];
    return [{ model, spacing, cycle: Date.parse(model.cycle ?? '') || 0 }];
  });
  candidates.sort((a, b) => a.spacing - b.spacing || b.cycle - a.cycle || (a.model.model < b.model.model ? -1 : Number(a.model.model > b.model.model)));
  return candidates.map(candidate => candidate.model);
}

export function selectBestCatalogModel(options: CatalogSelection): string | null {
  return rankCatalogModels(options)[0]?.model ?? null;
}

/** Match a rendered interval without extending the first or last valid time. */
export function selectAutoFrame<T extends FrameLike>(frames: readonly T[], validTimeMs: number): T | null {
  const valid = frames.map(frame => Date.parse(frame.validTime));
  if (!(validTimeMs >= Math.min(...valid) && validTimeMs <= Math.max(...valid))) return null;
  return frames.find((_, index) => valid[index] === validTimeMs) ??
    frames.find(frame => Date.parse(frame.intervalStart) <= validTimeMs && validTimeMs <= Date.parse(frame.intervalEnd)) ?? null;
}

export async function resolveAutoBuild(api: Pick<ApiClient, 'catalog' | 'latest' | 'sample'>, options: GeoPoint & {
  validTimeMs?: number;
  layers: readonly LayerId[];
  signal: AbortSignal;
}): Promise<AutoForecastSelection | null> {
  const { lat, lon, validTimeMs, layers } = options;
  const signal = typeof AbortSignal.any === 'function' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.any([options.signal, AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS)]) : options.signal;
  let models: CatalogModelEntry[];
  try { models = await api.catalog({ signal }); }
  catch {
    signal.throwIfAborted();
    models = MODEL_OPTIONS.map(({ modelId }) => ({ model: modelId, available: true }));
  }
  const tried = new Set<string>();
  for (const { model } of rankCatalogModels({ models, lat, lon, validTimeMs })) {
    signal.throwIfAborted();
    if (tried.has(model)) continue;
    tried.add(model);
    try {
      const build = await api.latest(model, { signal });
      if (build.expiresAtMs <= Date.now() || !withinGeographicBounds(lat, lon, build.manifest.descriptors.bounds)) continue;
      const layer = layers.find(id => build.templates[id]);
      const frames = renderedFrames(build.manifest);
      if (validTimeMs === undefined && frames.every(frame => Date.parse(frame.validTime) < Date.now())) continue;
      const frame = validTimeMs === undefined ? selectHostFrame(frames, Date.now()) : selectAutoFrame(frames, validTimeMs);
      if (!layer || !frame) continue;
      const sample = await api.sample(build, { lat, lon, layers: [layer], frames: [frame.id], signal });
      signal.throwIfAborted();
      const status = sample.frames[0]?.layers[layer]?.status;
      if (build.expiresAtMs > Date.now() && (status === 'valid' || status === 'no-usable-lift')) return { build, frame };
    } catch { signal.throwIfAborted(); }
  }
  signal.throwIfAborted();
  return null;
}
