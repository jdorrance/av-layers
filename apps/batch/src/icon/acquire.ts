import { recoverTrailingWindow } from '@av/forecast/intervals';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts';
import type { ModelLevelFrame } from '@av/forecast';
import { readLocalFile } from '../local-file.js';
import {
  ICON_EU_BASE_URL,
  ICON_EU_GRID,
  ICON_EU_FORECAST_HOURS,
  ICON_EU_HALF_LEVELS,
  ICON_EU_INTERVAL_HOURS,
  ICON_EU_MODEL_LEVELS,
  MAX_ICON_OBJECT_BYTES
} from './constants.js';
import { discoverIconEuRun } from './discover.js';
import {
  formatIconRunStamp,
  iconRegularFieldUrl,
  validateIconCycle,
  verifyIconFieldMetadata
} from './fields.js';
import { decodeIconGribField, type DecodedIconGribField } from './grib.js';
import type { NormalizedFrameTarget } from '../provider.js';

const DEFAULT_CONCURRENCY = 8;

export interface IconObjectReceipt {
  readonly field: string;
  readonly hour: number;
  readonly level: number | null;
  readonly url: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly sha256: string;
  readonly cacheHit: boolean;
}

export interface IconTransportStats {
  downloads: number;
  cacheHits: number;
  downloadedBytes: number;
  retries: number;
}

export interface IconAcquisitionOptions {
  readonly cycle?: string;
  readonly activeIndices: Uint32Array;
  readonly cacheDir: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly concurrency?: number;
  readonly signal?: AbortSignal;
  readonly readOnlyCache?: boolean;
  readonly offline?: boolean;
}

export interface IconStaticGeometryCache {
  readonly cycle: string;
  readonly terrainM: Float32Array;
  readonly missingTerrain: Uint8Array;
  readonly hgtM: Float32Array[];
  readonly missingHgt: Uint8Array[];
  readonly receipts: readonly IconObjectReceipt[];
}

const sha256Hex = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  let failed = false, failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed && nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      try { results[current] = await fn(items[current]!); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  };
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  if (failed) throw failure;
  return results;
}

async function readObjectBody(response: Response): Promise<Uint8Array> {
  const declaredBytes = response.headers.get('content-length');
  if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > MAX_ICON_OBJECT_BYTES)) {
    await response.body?.cancel();
    throw new Error('ICON object byte length out of bounds');
  }
  if (!response.body) throw new Error('Empty ICON object body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ICON_OBJECT_BYTES) throw new Error('ICON object byte length out of bounds');
      chunks.push(value);
    }
    if (!size) throw new Error('Empty ICON object body');
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function loadIconField(
  url: string,
  cacheDir: string,
  stats: IconTransportStats,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly readOnlyCache?: boolean; readonly offline?: boolean },
  decode: (bytes: Uint8Array) => DecodedIconGribField
): Promise<{ readonly decoded: DecodedIconGribField; readonly compressedBytes: number; readonly sha256: string; readonly cacheHit: boolean }> {
  options.signal?.throwIfAborted();
  const keyHash = createHash('sha256').update(url).digest('hex');
  const fileName = url.split('/').at(-1) ?? `${keyHash}.grib2.bz2`;
  const cachePath = join(cacheDir, 'objects', `${keyHash.slice(0, 16)}-${fileName}`);

  try {
    const cached = await readLocalFile(cachePath, MAX_ICON_OBJECT_BYTES);
    const decoded = decode(cached);
    stats.cacheHits += 1;
    return { decoded, compressedBytes: cached.byteLength, sha256: sha256Hex(cached), cacheHit: true };
  } catch (error) {
    if (options.readOnlyCache || options.offline) {
      throw new Error(`ICON offline cache miss or invalid object ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(cachePath, { force: true });
  }

  if (options.offline) throw new Error(`ICON offline cache miss for ${url}`);
  const fetchFn = options.fetchImpl ?? fetch;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    options.signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetchFn(url, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      const buffer = await readObjectBody(response);
      stats.downloads += 1;
      stats.downloadedBytes += buffer.byteLength;
      const decoded = decode(buffer);
      await mkdir(dirname(cachePath), { recursive: true });
      const tmpPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmpPath, buffer);
        await rename(tmpPath, cachePath);
      } finally { await rm(tmpPath, { force: true }); }
      return { decoded, compressedBytes: buffer.byteLength, sha256: sha256Hex(buffer), cacheHit: false };
    } catch (error) {
      lastError = error;
      if (options.signal?.aborted || attempt === 2) {
        break;
      }
      stats.retries += 1;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Failed to fetch ${url}`);
}

/**
 * Convert DWD's run-averaged downward surface flux (`0..h`, `W/m²` positive downward)
 * into the preceding-hour upward mean (`h-1..h`, `W/m²` positive upward).
 */
export function deaverageIconHourlyUpwardFlux(
  current: Pick<DecodedIconGribField, 'values' | 'missing' | 'product'>,
  previous: Pick<DecodedIconGribField, 'values' | 'missing' | 'product'> | null,
  hour: number
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  if (!Number.isInteger(hour) || hour < 1) {
    throw new Error(`ICON-EU flux de-averaging requires forecast hour >= 1, got ${hour}`);
  }
  if (hour > 1 && !previous) {
    throw new Error(`ICON-EU flux de-averaging for f${hour} requires companion f${hour - 1}`);
  }
  return recoverTrailingWindow({
    currentValues: current.values,
    currentMissing: current.missing,
    companionValues: hour > 1 ? previous!.values : null,
    companionMissing: hour > 1 ? previous!.missing : null,
    currentHours: hour,
    previousHours: hour - 1,
    statistic: 'mean',
    packingErrorCurrent: 0,
    packingErrorPrevious: 0,
    outputSign: -1
  });
}

/**
 * Compute full model-level geometric midpoint heights (`m` MSL) from time-invariant
 * half-level heights `HHL` (`45..75`) and verify surface agreement with `HSURF`.
 */
export function computeIconModelLevelHeights(
  hsurf: Pick<DecodedIconGribField, 'values' | 'missing'>,
  halfLevelsByLevel: ReadonlyMap<number, Pick<DecodedIconGribField, 'values' | 'missing'>>,
  modelLevels: readonly number[] = ICON_EU_MODEL_LEVELS
): { readonly hgtM: Float32Array[]; readonly missingHgt: Uint8Array[] } {
  const count = hsurf.values.length;
  const bottomHalfLevel = ICON_EU_HALF_LEVELS.at(-1)!;
  const bottomHalf = halfLevelsByLevel.get(bottomHalfLevel);
  if (!bottomHalf) {
    throw new Error(`ICON-EU static geometry requires HHL half-level ${bottomHalfLevel}`);
  }

  for (let i = 0; i < count; i += 1) {
    if (hsurf.missing[i] === 0 && bottomHalf.missing[i] === 0) {
      const diff = Math.abs(bottomHalf.values[i]! - hsurf.values[i]!);
      if (diff > 1.0) {
        throw new Error(
          `ICON-EU HHL level ${bottomHalfLevel} (${bottomHalf.values[i]}) disagrees with HSURF (${hsurf.values[i]}) at active cell ${i}`
        );
      }
    }
  }

  const hgtM: Float32Array[] = [];
  const missingHgt: Uint8Array[] = [];

  for (const level of modelLevels) {
    const upper = halfLevelsByLevel.get(level);
    const lower = halfLevelsByLevel.get(level + 1);
    if (!upper || !lower) {
      throw new Error(`ICON-EU missing HHL half-level ${level} or ${level + 1}`);
    }
    const levelHgt = new Float32Array(count);
    const levelMissing = new Uint8Array(count);

    for (let i = 0; i < count; i += 1) {
      if (
        upper.missing[i] !== 0 ||
        lower.missing[i] !== 0 ||
        !Number.isFinite(upper.values[i]!) ||
        !Number.isFinite(lower.values[i]!)
      ) {
        levelHgt[i] = NaN;
        levelMissing[i] = 1;
        continue;
      }
      const upperM = upper.values[i]!;
      const lowerM = lower.values[i]!;
      if (upperM <= lowerM) {
        throw new Error(
          `ICON-EU HHL half-levels inverted at level ${level} (upper=${upperM}, lower=${lowerM})`
        );
      }
      levelHgt[i] = 0.5 * (upperM + lowerM);
      levelMissing[i] = 0;
    }

    hgtM.push(levelHgt);
    missingHgt.push(levelMissing);
  }

  return { hgtM, missingHgt };
}

function copyActiveIndices(input: Uint32Array): Uint32Array {
  const cells = ICON_EU_GRID.width * ICON_EU_GRID.height;
  if (!(input instanceof Uint32Array) || !input.length || input.length > cells) throw new Error('Invalid ICON active index array');
  const indices = new Uint32Array(input), seen = new Uint8Array(Math.ceil(cells / 8));
  for (const index of indices) {
    const byte = index >> 3, bit = 1 << (index & 7);
    if (index >= cells || (seen[byte] & bit)) throw new Error(`Invalid or duplicate ICON active index ${index}`);
    seen[byte] |= bit;
  }
  return indices;
}

export async function createIconEuAcquisitionSession(options: IconAcquisitionOptions) {
  options.signal?.throwIfAborted();
  const baseUrl = options.baseUrl ?? ICON_EU_BASE_URL;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > DEFAULT_CONCURRENCY) throw new Error(`ICON concurrency must be an integer from 1 to ${DEFAULT_CONCURRENCY}`);
  const activeIndices = copyActiveIndices(options.activeIndices);
  const cycle = validateIconCycle(
    options.cycle ??
      (
        await discoverIconEuRun({
          baseUrl,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          cacheDir: options.cacheDir
        })
      ).cycle
  );

  const stats: IconTransportStats = {
    downloads: 0,
    cacheHits: 0,
    downloadedBytes: 0,
    retries: 0
  };

  let staticGeometryPromise: Promise<IconStaticGeometryCache> | null = null;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let active: Promise<ModelLevelFrame> | undefined;
  const fluxCache = new Map<
    string,
    Promise<{ readonly decoded: DecodedIconGribField; readonly receipt: IconObjectReceipt }>
  >();

  const loadDecodedField = async (
    field: string,
    hour: number,
    level: number | null = null,
    target?: { values: Float32Array; missing: Uint8Array }
  ): Promise<{ readonly decoded: DecodedIconGribField; readonly receipt: IconObjectReceipt }> => {
    const url = iconRegularFieldUrl(field, cycle, { hour, level, baseUrl });
    const { decoded, compressedBytes, sha256, cacheHit } = await loadIconField(
      url,
      options.cacheDir,
      stats,
      { fetchImpl: options.fetchImpl, signal, readOnlyCache: options.readOnlyCache, offline: options.offline },
      bytes => {
        const decoded = decodeIconGribField(bytes, activeIndices, target);
        verifyIconFieldMetadata(decoded, field, cycle, { hour, level });
        return decoded;
      }
    );
    return {
      decoded,
      receipt: {
        field,
        hour,
        level,
        url,
        compressedBytes,
        expandedBytes: decoded.expandedBytes,
        sha256,
        cacheHit
      }
    };
  };

  const getFluxField = (
    field: 'ASHFL_S' | 'ALHFL_S',
    hour: number
  ): Promise<{ readonly decoded: DecodedIconGribField; readonly receipt: IconObjectReceipt }> => {
    const key = `${field}:${hour}`;
    const existing = fluxCache.get(key);
    if (existing) {
      return existing;
    }
    const pending = loadDecodedField(field, hour, null).catch(error => {
      fluxCache.delete(key);
      throw error;
    });
    fluxCache.set(key, pending);
    return pending;
  };

  const getStaticGeometry = (): Promise<IconStaticGeometryCache> => {
    if (staticGeometryPromise) {
      return staticGeometryPromise;
    }
    staticGeometryPromise = (async () => {
      const hsurfRes = await loadDecodedField('HSURF', 0, null);
      const hhlResults = await mapConcurrent(ICON_EU_HALF_LEVELS, concurrency, level =>
        loadDecodedField('HHL', 0, level)
      );
      const halfMap = new Map<number, DecodedIconGribField>();
      for (let i = 0; i < ICON_EU_HALF_LEVELS.length; i += 1) {
        halfMap.set(ICON_EU_HALF_LEVELS[i]!, hhlResults[i]!.decoded);
      }
      const { hgtM, missingHgt } = computeIconModelLevelHeights(
        hsurfRes.decoded,
        halfMap,
        ICON_EU_MODEL_LEVELS
      );
      return {
        cycle,
        terrainM: hsurfRes.decoded.values,
        missingTerrain: hsurfRes.decoded.missing,
        hgtM,
        missingHgt,
        receipts: [hsurfRes.receipt, ...hhlResults.map(r => r.receipt)]
      };
    })().catch(error => {
      staticGeometryPromise = null;
      throw error;
    });
    return staticGeometryPromise;
  };

  const acquireFrame = async (hour: number, target?: NormalizedFrameTarget): Promise<ModelLevelFrame> => {
    for (const key of fluxCache.keys()) if (!key.endsWith(`:${hour - 1}`)) fluxCache.delete(key);
    const staticGeom = await getStaticGeometry();

    const surfaceFields = ['PS', 'T_2M', 'QV_2M', 'ASHFL_S', 'ALHFL_S'];
    const requests = [
      ...surfaceFields.map(field => ({ field, hour, level: null })),
      ...(hour > 1 ? ['ASHFL_S', 'ALHFL_S'].map(field => ({ field, hour: hour - 1, level: null })) : []),
      ...['T', 'P'].flatMap(field => ICON_EU_MODEL_LEVELS.map(level => ({ field, hour, level })))
    ];
    const fields = await mapConcurrent(requests, concurrency, request =>
      request.field === 'ASHFL_S' || request.field === 'ALHFL_S'
        ? getFluxField(request.field, request.hour)
        : loadDecodedField(request.field, request.hour, request.level, target ? (() => {
          if (request.field === 'PS') return { values: target.surfacePressurePa, missing: target.missing.surfacePressure };
          if (request.field === 'T_2M') return { values: target.temp2mK, missing: target.missing.temp2m };
          if (request.field === 'QV_2M') return { values: target.specificHumidity2mKgKg, missing: target.missing.humidity2m };
          const index = ICON_EU_MODEL_LEVELS.indexOf(request.level!);
          return request.field === 'T' ? { values: target.tempK[index]!, missing: target.missing.temp[index]! }
            : { values: target.pressurePa![index]!, missing: target.missing.pressure![index]! };
        })() : undefined)
    );
    const [psRes, t2mRes, qv2mRes, ashflCurr, alhflCurr] = fields;
    const ashflPrev = hour > 1 ? fields[surfaceFields.length] : null;
    const alhflPrev = hour > 1 ? fields[surfaceFields.length + 1] : null;
    const modelOffset = surfaceFields.length + (hour > 1 ? 2 : 0);
    const modelTResults = fields.slice(modelOffset, modelOffset + ICON_EU_MODEL_LEVELS.length);
    const modelPResults = fields.slice(modelOffset + ICON_EU_MODEL_LEVELS.length);

    const sensible = deaverageIconHourlyUpwardFlux(
      ashflCurr.decoded,
      ashflPrev?.decoded ?? null,
      hour
    );
    const latent = deaverageIconHourlyUpwardFlux(
      alhflCurr.decoded,
      alhflPrev?.decoded ?? null,
      hour
    );
    if (target) {
      target.terrainM.set(staticGeom.terrainM); target.missing.terrain.set(staticGeom.missingTerrain);
      for (let i = 0; i < staticGeom.hgtM.length; i++) { target.hgtM[i]!.set(staticGeom.hgtM[i]!); target.missing.hgt[i]!.set(staticGeom.missingHgt[i]!); }
      target.sensibleHeatFluxWm2.set(sensible.values); target.missing.sensibleHeatFlux.set(sensible.missing);
      target.latentHeatFluxWm2.set(latent.values); target.missing.latentHeatFlux.set(latent.missing);
    }

    const cycleMs = Date.parse(cycle);
    const startIso = new Date(cycleMs + (hour - ICON_EU_INTERVAL_HOURS) * 3_600_000).toISOString();
    const endIso = new Date(cycleMs + hour * 3_600_000).toISOString();
    const runStartIso = new Date(cycleMs).toISOString();
    const capturedAt = new Date().toISOString();
    const { runStamp } = formatIconRunStamp(cycle);

    const hourlyReceipts: IconObjectReceipt[] = [
      psRes.receipt,
      t2mRes.receipt,
      qv2mRes.receipt,
      ashflCurr.receipt,
      alhflCurr.receipt,
      ...(ashflPrev ? [ashflPrev.receipt] : []),
      ...(alhflPrev ? [alhflPrev.receipt] : []),
      ...modelTResults.map(r => r.receipt),
      ...modelPResults.map(r => r.receipt)
    ];

    return {
      cycle,
      hour,
      validAt: endIso,
      capturedAt,
      grid: ICON_EU_GRID,
      activeIndices: new Uint32Array(activeIndices),
      terrainM: target?.terrainM ?? new Float32Array(staticGeom.terrainM),
      surfacePressurePa: psRes.decoded.values,
      temp2mK: t2mRes.decoded.values,
      specificHumidity2mKgKg: qv2mRes.decoded.values,
      sensibleHeatFluxWm2: target?.sensibleHeatFluxWm2 ?? sensible.values,
      latentHeatFluxWm2: target?.latentHeatFluxWm2 ?? latent.values,
      pressurePa: modelPResults.map(r => r.decoded.values),
      hgtM: target?.hgtM ?? staticGeom.hgtM.map(arr => new Float32Array(arr)),
      tempK: modelTResults.map(r => r.decoded.values),
      missing: {
        terrain: target?.missing.terrain ?? new Uint8Array(staticGeom.missingTerrain),
        surfacePressure: psRes.decoded.missing,
        temp2m: t2mRes.decoded.missing,
        humidity2m: qv2mRes.decoded.missing,
        sensibleHeatFlux: target?.missing.sensibleHeatFlux ?? sensible.missing,
        latentHeatFlux: target?.missing.latentHeatFlux ?? latent.missing,
        pressure: modelPResults.map(r => r.decoded.missing),
        hgt: target?.missing.hgt ?? staticGeom.missingHgt.map(arr => new Uint8Array(arr)),
        temp: modelTResults.map(r => r.decoded.missing)
      },
      intervals: {
        profileTime: endIso,
        fluxWindow: { start: startIso, end: endIso },
        fluxSourceWindow: { start: runStartIso, end: endIso },
        usedCompanion: hour > 1
      },
      receipt: {
        schemaVersion: 1,
        provider: 'DWD',
        model: 'icon-eu',
        gridKind: 'regridded-regular-lat-lon',
        runStamp,
        cycle,
        hour,
        validAt: endIso,
        capturedAt,
        modelLevels: [...ICON_EU_MODEL_LEVELS],
        staticObjects: staticGeom.receipts.length,
        hourlyObjects: hourlyReceipts.length,
        objects: [...staticGeom.receipts, ...hourlyReceipts]
      }
    };
  };

  return {
    cycle,
    get stats(): Readonly<IconTransportStats> {
      return { ...stats };
    },
    async acquire(hour: number, target?: NormalizedFrameTarget): Promise<ModelLevelFrame> {
      signal.throwIfAborted();
      if (!ICON_EU_FORECAST_HOURS.includes(hour)) {
        throw new Error(`Unsupported ICON-EU forecast hour ${hour}`);
      }
      if (active) throw new Error('ICON acquisition session already has an active frame');
      active = acquireFrame(hour, target);
      try {
        const frame = await active;
        signal.throwIfAborted();
        return frame;
      } finally {
        // Only this hour's pair can be reused as the next frame's companions.
        for (const key of fluxCache.keys()) if (!key.endsWith(`:${hour}`)) fluxCache.delete(key);
        active = undefined;
      }
    },
    async close(): Promise<void> {
      controller.abort(new Error('ICON acquisition session is closed'));
      await Promise.allSettled([active]);
      fluxCache.clear();
      staticGeometryPromise = null;
    }
  };
}
