import { MAX_SPLIT_OBJECT_BYTES, type SplitSource } from './source.js';
import { copySourceIndices, sourceWindowStart } from '../source.js';
import { recoverTrailingWindow } from '@av/forecast/intervals';
import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts';
import type { ModelLevelFrame } from '@av/forecast';
import { readLocalFile } from '../local-file.js';
import { discoverSplitGribRun } from './discover.js';
import {
  formatSplitGribRunStamp,
  splitGribRegularFieldUrl,
  validateSplitGribCycle,
  verifySplitGribFieldMetadata
} from './fields.js';
import { decodeSplitGribField, type DecodedSplitGribField } from './grib.js';
import type { NormalizedFrameTarget } from '../provider.js';

const DEFAULT_CONCURRENCY = 8;

export interface SplitGribObjectReceipt {
  readonly field: string;
  readonly hour: number;
  readonly level: number | null;
  readonly url: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly sha256: string;
  readonly cacheHit: boolean;
}

export interface SplitGribTransportStats {
  [key: string]: unknown;
  downloads: number;
  cacheHits: number;
  downloadedBytes: number;
  retries: number;
}

export interface SplitGribAcquisitionOptions {
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

export interface SplitGribStaticGeometryCache {
  readonly cycle: string;
  readonly terrainM: Float32Array;
  readonly missingTerrain: Uint8Array;
  readonly hgtM: Float32Array[];
  readonly missingHgt: Uint8Array[];
  readonly receipts: readonly SplitGribObjectReceipt[];
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
  if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > MAX_SPLIT_OBJECT_BYTES)) {
    await response.body?.cancel();
    throw new Error('Split GRIB object byte length out of bounds');
  }
  if (!response.body) throw new Error('Empty Split GRIB object body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SPLIT_OBJECT_BYTES) throw new Error('Split GRIB object byte length out of bounds');
      chunks.push(value);
    }
    if (!size) throw new Error('Empty Split GRIB object body');
    return Buffer.concat(chunks, size);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

async function loadSplitGribField(
  url: string,
  cacheDir: string,
  stats: SplitGribTransportStats,
  options: { readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal; readonly readOnlyCache?: boolean; readonly offline?: boolean },
  decode: (bytes: Uint8Array) => DecodedSplitGribField
): Promise<{ readonly decoded: DecodedSplitGribField; readonly compressedBytes: number; readonly sha256: string; readonly cacheHit: boolean }> {
  options.signal?.throwIfAborted();
  const keyHash = createHash('sha256').update(url).digest('hex');
  const fileName = url.split('/').at(-1) ?? `${keyHash}.grib2.bz2`;
  const cachePath = join(cacheDir, 'objects', `${keyHash.slice(0, 16)}-${fileName}`);

  try {
    const cached = await readLocalFile(cachePath, MAX_SPLIT_OBJECT_BYTES);
    const decoded = decode(cached);
    stats.cacheHits += 1;
    return { decoded, compressedBytes: cached.byteLength, sha256: sha256Hex(cached), cacheHit: true };
  } catch (error) {
    if (options.readOnlyCache || options.offline) {
      throw new Error(`Split GRIB offline cache miss or invalid object ${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await rm(cachePath, { force: true });
  }

  if (options.offline) throw new Error(`Split GRIB offline cache miss for ${url}`);
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

/** Recover the configured trailing flux mean and orientation. */
export function recoverSplitGribFlux(source: SplitSource, role: 'sensibleHeatFlux' | 'latentHeatFlux',
  current: Pick<DecodedSplitGribField, 'values' | 'missing' | 'product'>,
  previous: Pick<DecodedSplitGribField, 'values' | 'missing' | 'product'> | null,
  hour: number
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  if (!Number.isInteger(hour) || hour < 1) {
    throw new Error(`Split GRIB flux de-averaging requires forecast hour >= 1, got ${hour}`);
  }
  const start = sourceWindowStart(source.model.forecast, hour), previousHour = hour - source.model.forecast.intervalHours;
  if (previousHour > start && !previous) {
    throw new Error(`Split GRIB flux de-averaging for f${hour} requires companion f${hour - source.model.forecast.intervalHours}`);
  }
  return recoverTrailingWindow({
    currentValues: current.values,
    currentMissing: current.missing,
    companionValues: previousHour > start ? previous!.values : null,
    companionMissing: previousHour > start ? previous!.missing : null,
    currentHours: hour - start,
    previousHours: previousHour - start,
    statistic: 'mean',
    packingErrorCurrent: 0,
    packingErrorPrevious: 0,
    outputSign: source.upstream.fields[role].scale
  });
}

/** Build midpoint heights from configured interfaces and verify ground agreement. */
export function computeSplitGribModelLevelHeights(source: SplitSource,
  hsurf: Pick<DecodedSplitGribField, 'values' | 'missing'>,
  halfLevelsByLevel: ReadonlyMap<number, Pick<DecodedSplitGribField, 'values' | 'missing'>>,
  modelLevels: readonly number[] = source.modelLevels
): { readonly hgtM: Float32Array[]; readonly missingHgt: Uint8Array[] } {
  const count = hsurf.values.length;
  const bottomHalfLevel = source.halfLevels.at(-1)!;
  const bottomHalf = halfLevelsByLevel.get(bottomHalfLevel);
  if (!bottomHalf) {
    throw new Error(`Split GRIB static geometry requires HHL half-level ${bottomHalfLevel}`);
  }

  for (let i = 0; i < count; i += 1) {
    if (hsurf.missing[i] === 0 && bottomHalf.missing[i] === 0) {
      const diff = Math.abs(bottomHalf.values[i]! - hsurf.values[i]!);
      if (diff > 1.0) {
        throw new Error(
          `Split GRIB HHL level ${bottomHalfLevel} (${bottomHalf.values[i]}) disagrees with HSURF (${hsurf.values[i]}) at active cell ${i}`
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
      throw new Error(`Split GRIB missing HHL half-level ${level} or ${level + 1}`);
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
          `Split GRIB HHL half-levels inverted at level ${level} (upper=${upperM}, lower=${lowerM})`
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


export async function createSplitGribAcquisitionSession(source: SplitSource, options: SplitGribAcquisitionOptions) {
  options.signal?.throwIfAborted();
  const baseUrl = options.baseUrl ?? source.upstream.urlTemplate.split('/{cycleHour}')[0]!;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > DEFAULT_CONCURRENCY) throw new Error(`Split GRIB concurrency must be an integer from 1 to ${DEFAULT_CONCURRENCY}`);
  const activeIndices = copySourceIndices(options.activeIndices, source.grid.width * source.grid.height);
  const cycle = validateSplitGribCycle(source,
    options.cycle ??
      (
        await discoverSplitGribRun(source, {
          baseUrl,
          fetchImpl: options.fetchImpl,
          signal: options.signal,
          cacheDir: options.cacheDir
        })
      ).cycle
  );

  const stats: SplitGribTransportStats = {
    downloads: 0,
    cacheHits: 0,
    downloadedBytes: 0,
    retries: 0
  };

  let staticGeometryPromise: Promise<SplitGribStaticGeometryCache> | null = null;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let active: Promise<ModelLevelFrame> | undefined;
  const fluxCache = new Map<
    string,
    Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }>
  >();

  const loadDecodedField = async (
    field: string,
    hour: number,
    level: number | null = null,
    target?: { values: Float32Array; missing: Uint8Array }
  ): Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }> => {
    const url = splitGribRegularFieldUrl(source, field, cycle, { hour, level, baseUrl });
    const { decoded, compressedBytes, sha256, cacheHit } = await loadSplitGribField(
      url,
      options.cacheDir,
      stats,
      { fetchImpl: options.fetchImpl, signal, readOnlyCache: options.readOnlyCache, offline: options.offline },
      bytes => {
        const decoded = decodeSplitGribField(source, bytes, activeIndices, target);
        verifySplitGribFieldMetadata(source, decoded, field, cycle, { hour, level });
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
    field: string,
    hour: number
  ): Promise<{ readonly decoded: DecodedSplitGribField; readonly receipt: SplitGribObjectReceipt }> => {
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

  const getStaticGeometry = (): Promise<SplitGribStaticGeometryCache> => {
    if (staticGeometryPromise) {
      return staticGeometryPromise;
    }
    staticGeometryPromise = (async () => {
      const hsurfRes = await loadDecodedField(source.fields.staticTerrain, 0, null);
      const hhlResults = await mapConcurrent(source.halfLevels, concurrency, level =>
        loadDecodedField(source.fields.halfLevelHeight, 0, level)
      );
      const halfMap = new Map<number, DecodedSplitGribField>();
      for (let i = 0; i < source.halfLevels.length; i += 1) {
        halfMap.set(source.halfLevels[i]!, hhlResults[i]!.decoded);
      }
      const { hgtM, missingHgt } = computeSplitGribModelLevelHeights(source,
        hsurfRes.decoded,
        halfMap,
        source.modelLevels
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
    for (const key of fluxCache.keys()) if (!key.endsWith(`:${hour - source.model.forecast.intervalHours}`)) fluxCache.delete(key);
    const staticGeom = await getStaticGeometry();
    const needsCompanion = hour - source.model.forecast.intervalHours > sourceWindowStart(source.model.forecast, hour);

    const surfaceFields = [source.fields.surfacePressure, source.fields.temperature2m, source.fields.specificHumidity2m, source.fields.sensibleHeatFlux, source.fields.latentHeatFlux];
    const requests = [
      ...surfaceFields.map(field => ({ field, hour, level: null })),
      ...(needsCompanion ? [source.fields.sensibleHeatFlux, source.fields.latentHeatFlux].map(field => ({ field, hour: hour - source.model.forecast.intervalHours, level: null })) : []),
      ...[source.fields.temperature, source.fields.pressure].flatMap(field => source.modelLevels.map(level => ({ field, hour, level })))
    ];
    const fields = await mapConcurrent(requests, concurrency, request =>
      request.field === source.fields.sensibleHeatFlux || request.field === source.fields.latentHeatFlux
        ? getFluxField(request.field, request.hour)
        : loadDecodedField(request.field, request.hour, request.level, target ? (() => {
          if (request.field === source.fields.surfacePressure) return { values: target.surfacePressurePa, missing: target.missing.surfacePressure };
          if (request.field === source.fields.temperature2m) return { values: target.temp2mK, missing: target.missing.temp2m };
          if (request.field === source.fields.specificHumidity2m) return { values: target.specificHumidity2mKgKg, missing: target.missing.humidity2m };
          const index = source.modelLevels.indexOf(request.level!);
          return request.field === source.fields.temperature ? { values: target.tempK[index]!, missing: target.missing.temp[index]! }
            : { values: target.pressurePa![index]!, missing: target.missing.pressure![index]! };
        })() : undefined)
    );
    const [psRes, t2mRes, qv2mRes, ashflCurr, alhflCurr] = fields;
    const ashflPrev = needsCompanion ? fields[surfaceFields.length] : null;
    const alhflPrev = needsCompanion ? fields[surfaceFields.length + 1] : null;
    const modelOffset = surfaceFields.length + (needsCompanion ? 2 : 0);
    const modelTResults = fields.slice(modelOffset, modelOffset + source.modelLevels.length);
    const modelPResults = fields.slice(modelOffset + source.modelLevels.length);

    const sensible = recoverSplitGribFlux(source, 'sensibleHeatFlux',
      ashflCurr.decoded,
      ashflPrev?.decoded ?? null,
      hour
    );
    const latent = recoverSplitGribFlux(source, 'latentHeatFlux',
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
    const startIso = new Date(cycleMs + (hour - source.model.forecast.intervalHours) * 3_600_000).toISOString();
    const endIso = new Date(cycleMs + hour * 3_600_000).toISOString();
    const sourceStartIso = new Date(cycleMs + sourceWindowStart(source.model.forecast, hour) * 3_600_000).toISOString();
    const capturedAt = new Date().toISOString();
    const { runStamp } = formatSplitGribRunStamp(source, cycle);

    const hourlyReceipts: SplitGribObjectReceipt[] = [
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
      grid: source.grid,
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
        fluxSourceWindow: { start: sourceStartIso, end: endIso },
        usedCompanion: needsCompanion
      },
      receipt: {
        schemaVersion: 1,
        provider: source.upstream.provider,
        model: source.model.modelId,
        gridKind: 'regridded-regular-lat-lon',
        runStamp,
        cycle,
        hour,
        validAt: endIso,
        capturedAt,
        modelLevels: [...source.modelLevels],
        staticObjects: staticGeom.receipts.length,
        hourlyObjects: hourlyReceipts.length,
        objects: [...staticGeom.receipts, ...hourlyReceipts]
      }
    };
  };

  return {
    cycle,
    get stats(): Readonly<SplitGribTransportStats> {
      return { ...stats };
    },
    async acquire(hour: number, target?: NormalizedFrameTarget): Promise<ModelLevelFrame> {
      signal.throwIfAborted();
      if (!source.model.forecast.hours.includes(hour)) {
        throw new Error(`Unsupported Split GRIB forecast hour ${hour}`);
      }
      if (active) throw new Error('Split GRIB acquisition session already has an active frame');
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
      controller.abort(new Error('Split GRIB acquisition session is closed'));
      await Promise.allSettled([active]);
      fluxCache.clear();
      staticGeometryPromise = null;
    }
  };
}
