import { MAX_SPLIT_OBJECT_BYTES, type SplitSource } from './source.js';
import { copySourceIndices, sourceWindowStart } from '../source.js';
import { recoverTrailingWindow } from '@av/forecast/intervals';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DEFAULT_REQUEST_TIMEOUT_MS, sourceIntervalHours } from '@av/contracts';
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
import { createAuxiliaryTargets, type NormalizedFrameTarget } from '../provider.js';
import type { AuxSurfaceId, AuxLevelId, AuxField } from '@av/forecast/inputs';
import { pause } from '../pause.js';

const DEFAULT_CONCURRENCY = 8;
const MAX_TRANSFER_ATTEMPTS = 3;
const RETRYABLE_HTTP_STATUS = [408, 429, 500, 502, 503, 504];

export interface SplitGribObjectReceipt {
  readonly field: string;
  readonly hour: number;
  readonly level: number | null;
  readonly url: string;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly sha256: string;
  readonly cacheHit: boolean;
  readonly normalization?: { units: string; scale: number };
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

class InvalidSplitGribResponse extends Error {}

async function readObjectBody(response: Response): Promise<Uint8Array> {
  const declaredBytes = response.headers.get('content-length');
  if (declaredBytes !== null && (!/^\d+$/.test(declaredBytes) || Number(declaredBytes) > MAX_SPLIT_OBJECT_BYTES)) {
    await response.body?.cancel().catch(() => {});
    throw new InvalidSplitGribResponse('Split GRIB object byte length out of bounds');
  }
  if (!response.body) throw new InvalidSplitGribResponse('Empty Split GRIB object body');
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SPLIT_OBJECT_BYTES) throw new InvalidSplitGribResponse('Split GRIB object byte length out of bounds');
      chunks.push(value);
    }
    if (!size) throw new InvalidSplitGribResponse('Empty Split GRIB object body');
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

  let cached: Buffer | undefined;
  try {
    cached = await readLocalFile(cachePath, MAX_SPLIT_OBJECT_BYTES);
    options.signal?.throwIfAborted();
    const decoded = decode(cached);
    stats.cacheHits += 1;
    return { decoded, compressedBytes: cached.byteLength, sha256: sha256Hex(cached), cacheHit: true };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (options.readOnlyCache || options.offline) {
      throw new Error(`Split GRIB offline cache miss or invalid object ${url}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (!cached && code && code !== 'ENOENT') throw error;
  }

  const fetchFn = options.fetchImpl ?? fetch;
  let buffer: Uint8Array;
  for (let attempt = 1; ; attempt++) {
    options.signal?.throwIfAborted();
    try {
      const timeout = AbortSignal.timeout(DEFAULT_REQUEST_TIMEOUT_MS);
      const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
      const response = await fetchFn(url, { signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const message = `HTTP ${response.status} for ${url}`;
        if (!RETRYABLE_HTTP_STATUS.includes(response.status)) throw new InvalidSplitGribResponse(message);
        throw new Error(message);
      }
      buffer = await readObjectBody(response);
      break;
    } catch (error) {
      options.signal?.throwIfAborted();
      if (error instanceof InvalidSplitGribResponse || attempt === MAX_TRANSFER_ATTEMPTS) throw error;
      await pause(Math.ceil(250 * 2 ** (attempt - 1) * (0.5 + Math.random())), options.signal);
      stats.retries += 1;
    }
  }
  options.signal?.throwIfAborted();
  stats.downloads += 1;
  stats.downloadedBytes += buffer.byteLength;
  const decoded = decode(buffer);
  await mkdir(dirname(cachePath), { recursive: true });
  const tmpPath = `${cachePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmpPath, buffer, { flag: 'wx', signal: options.signal });
    options.signal?.throwIfAborted();
    await rename(tmpPath, cachePath);
  } finally { await rm(tmpPath, { force: true }).catch(() => {}); }
  return { decoded, compressedBytes: buffer.byteLength, sha256: sha256Hex(buffer), cacheHit: false };
}

type WindowField = Pick<DecodedSplitGribField, 'values' | 'missing' | 'product'> & Partial<Pick<DecodedSplitGribField, 'representation'>>;

/** Recover the configured trailing flux mean and orientation. */
export function recoverSplitGribFlux(source: SplitSource, role: 'sensibleHeatFlux' | 'latentHeatFlux',
  current: WindowField, previous: WindowField | null, hour: number
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  return recoverWindow(source, current, previous, hour, 'mean', source.upstream.fields[role].scale);
}

function recoverWindow(source: SplitSource, current: WindowField, previous: WindowField | null, hour: number,
  statistic: 'mean' | 'accumulation', outputSign: 1 | -1 = 1
): { readonly values: Float32Array; readonly missing: Uint8Array } {
  if (!Number.isInteger(hour) || hour < 1) {
    throw new Error(`Split GRIB window recovery requires forecast hour >= 1, got ${hour}`);
  }
  const start = sourceWindowStart(source.model.forecast, hour), previousHour = hour - sourceIntervalHours(source.model.forecast, hour);
  if (previousHour > start && !previous) {
    throw new Error(`Split GRIB window recovery for f${hour} requires companion f${hour - sourceIntervalHours(source.model.forecast, hour)}`);
  }
  return recoverTrailingWindow({
    currentValues: current.values,
    currentMissing: current.missing,
    companionValues: previousHour > start ? previous!.values : null,
    companionMissing: previousHour > start ? previous!.missing : null,
    currentHours: hour - start,
    previousHours: previousHour - start,
    statistic,
    packingErrorCurrent: current.representation?.packingError ?? 0,
    packingErrorPrevious: previous?.representation?.packingError ?? 0,
    outputSign
  });
}

function frameValues({ values }: DecodedSplitGribField): Float32Array {
  if (!(values instanceof Float32Array)) throw new Error('Split GRIB frame values require Float32 data');
  return values;
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
    const normalization = source.specs[field]!.normalization;
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
        cacheHit,
        ...(normalization ? { normalization } : {})
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
        terrainM: frameValues(hsurfRes.decoded),
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
    for (const key of fluxCache.keys()) if (!key.endsWith(`:${hour - sourceIntervalHours(source.model.forecast, hour)}`)) fluxCache.delete(key);
    const staticGeom = await getStaticGeometry();
    const needsCompanion = hour - sourceIntervalHours(source.model.forecast, hour) > sourceWindowStart(source.model.forecast, hour);
    const { auxSurface, auxLevels } = createAuxiliaryTargets(activeIndices.length, source.modelLevels.length,
      Object.keys(source.upstream.auxSurface ?? {}) as AuxSurfaceId[], Object.keys(source.upstream.auxLevels ?? {}) as AuxLevelId[], target);
    const auxiliaryTargets = new Map<string, AuxField>();
    const auxiliaryRequests = [
      ...Object.entries(source.upstream.auxSurface ?? {}).map(([id, spec]) => {
        auxiliaryTargets.set(`${spec.field}:null`, auxSurface[id as AuxSurfaceId]!);
        return { field: spec.field, hour, level: null };
      }),
      ...Object.entries(source.upstream.auxLevels ?? {}).flatMap(([id, spec]) => source.modelLevels.map((level, index) => {
        auxiliaryTargets.set(`${spec.field}:${level}`, auxLevels[id as AuxLevelId]![index]!);
        return { field: spec.field, hour, level };
      }))
    ];

    const surfaceFields = [source.fields.surfacePressure, source.fields.temperature2m, source.fields.specificHumidity2m, source.fields.sensibleHeatFlux, source.fields.latentHeatFlux];
    const precipitationField = source.model.layers.includes('precip-rate') ? source.fields.precipitation : undefined;
    const precipitationRequests = precipitationField ? [
      { field: precipitationField, hour, level: null },
      ...(needsCompanion ? [{ field: precipitationField, hour: hour - sourceIntervalHours(source.model.forecast, hour), level: null }] : [])
    ] : [];
    const requests = [
      ...surfaceFields.map(field => ({ field, hour, level: null })),
      ...(needsCompanion ? [source.fields.sensibleHeatFlux, source.fields.latentHeatFlux].map(field => ({ field, hour: hour - sourceIntervalHours(source.model.forecast, hour), level: null })) : []),
      ...[source.fields.temperature, source.fields.pressure].flatMap(field => source.modelLevels.map(level => ({ field, hour, level }))),
      ...precipitationRequests,
      ...auxiliaryRequests
    ];
    const fields = await mapConcurrent(requests, concurrency, request =>
      request.field === source.fields.sensibleHeatFlux || request.field === source.fields.latentHeatFlux || request.field === precipitationField
        ? getFluxField(request.field, request.hour)
        : loadDecodedField(request.field, request.hour, request.level, auxiliaryTargets.get(`${request.field}:${request.level}`) ?? (target ? (() => {
          if (request.field === source.fields.surfacePressure) return { values: target.surfacePressurePa, missing: target.missing.surfacePressure };
          if (request.field === source.fields.temperature2m) return { values: target.temp2mK, missing: target.missing.temp2m };
          if (request.field === source.fields.specificHumidity2m) return { values: target.specificHumidity2mKgKg, missing: target.missing.humidity2m };
          const index = source.modelLevels.indexOf(request.level!);
          return request.field === source.fields.temperature ? { values: target.tempK[index]!, missing: target.missing.temp[index]! }
            : { values: target.pressurePa![index]!, missing: target.missing.pressure![index]! };
        })() : undefined))
    );
    const [psRes, t2mRes, qv2mRes, ashflCurr, alhflCurr] = fields;
    const ashflPrev = needsCompanion ? fields[surfaceFields.length] : null;
    const alhflPrev = needsCompanion ? fields[surfaceFields.length + 1] : null;
    const modelOffset = surfaceFields.length + (needsCompanion ? 2 : 0);
    const modelTResults = fields.slice(modelOffset, modelOffset + source.modelLevels.length);
    const modelPResults = fields.slice(modelOffset + source.modelLevels.length, modelOffset + 2 * source.modelLevels.length);
    const precipitationIndex = modelOffset + 2 * source.modelLevels.length;
    const precipitation = precipitationField ? recoverWindow(source, fields[precipitationIndex]!.decoded,
      needsCompanion ? fields[precipitationIndex + 1]!.decoded : null, hour, 'accumulation') : undefined;
    for (const [configured, output] of [[source.upstream.auxSurface, auxSurface], [source.upstream.auxLevels, auxLevels]] as const) {
      for (const [name, spec] of Object.entries(configured ?? {})) {
        const selected = output[name as keyof typeof output] as AuxField | readonly AuxField[];
        for (const field of Array.isArray(selected) ? selected : [selected as AuxField]) {
          if (spec.scale !== 1) for (let i = 0; i < field.values.length; i++) if (!field.missing[i]) field.values[i] *= spec.scale;
        }
      }
    }
    // Admitted template 3.0 has east/north +i/+j axes; scan order changes sample order.
    const normalizeWind = (u: AuxField | undefined, v: AuxField | undefined) => {
      if (!u || !v) return;
      for (let i = 0; i < activeIndices.length; i++) if (u.missing[i] || v.missing[i]) {
        u.missing[i] = v.missing[i] = 1; u.values[i] = v.values[i] = NaN;
      }
    };
    normalizeWind(auxSurface.u10mMps, auxSurface.v10mMps);
    for (let i = 0; i < source.modelLevels.length; i++) normalizeWind(auxLevels.uWindMps?.[i], auxLevels.vWindMps?.[i]);

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
      if (precipitation && target.precipitationMmPerHour && target.missing.precipitation) {
        target.precipitationMmPerHour.set(precipitation.values); target.missing.precipitation.set(precipitation.missing);
      }
    }

    const cycleMs = Date.parse(cycle);
    const startIso = new Date(cycleMs + (hour - sourceIntervalHours(source.model.forecast, hour)) * 3_600_000).toISOString();
    const endIso = new Date(cycleMs + hour * 3_600_000).toISOString();
    const sourceStartIso = new Date(cycleMs + sourceWindowStart(source.model.forecast, hour) * 3_600_000).toISOString();
    const capturedAt = new Date().toISOString();
    const { runStamp } = formatSplitGribRunStamp(source, cycle);
    const precipitationOutput = precipitation && target?.precipitationMmPerHour && target.missing.precipitation
      ? { values: target.precipitationMmPerHour, missing: target.missing.precipitation } : precipitation;

    const hourlyReceipts: SplitGribObjectReceipt[] = fields.map(result => result.receipt);

    return {
      cycle,
      hour,
      validAt: endIso,
      capturedAt,
      grid: source.grid,
      activeIndices: new Uint32Array(activeIndices),
      terrainM: target?.terrainM ?? new Float32Array(staticGeom.terrainM),
      surfacePressurePa: frameValues(psRes.decoded),
      temp2mK: frameValues(t2mRes.decoded),
      specificHumidity2mKgKg: frameValues(qv2mRes.decoded),
      sensibleHeatFluxWm2: target?.sensibleHeatFluxWm2 ?? sensible.values,
      latentHeatFluxWm2: target?.latentHeatFluxWm2 ?? latent.values,
      ...(precipitationOutput ? { precipitationMmPerHour: precipitationOutput.values } : {}),
      pressurePa: modelPResults.map(r => frameValues(r.decoded)),
      hgtM: target?.hgtM ?? staticGeom.hgtM.map(arr => new Float32Array(arr)),
      tempK: modelTResults.map(r => frameValues(r.decoded)),
      ...(Object.keys(auxSurface).length ? { auxSurface } : {}),
      ...(Object.keys(auxLevels).length ? { auxLevels } : {}),
      missing: {
        terrain: target?.missing.terrain ?? new Uint8Array(staticGeom.missingTerrain),
        surfacePressure: psRes.decoded.missing,
        temp2m: t2mRes.decoded.missing,
        humidity2m: qv2mRes.decoded.missing,
        sensibleHeatFlux: target?.missing.sensibleHeatFlux ?? sensible.missing,
        latentHeatFlux: target?.missing.latentHeatFlux ?? latent.missing,
        ...(precipitationOutput ? { precipitation: precipitationOutput.missing } : {}),
        pressure: modelPResults.map(r => r.decoded.missing),
        hgt: target?.missing.hgt ?? staticGeom.missingHgt.map(arr => new Uint8Array(arr)),
        temp: modelTResults.map(r => r.decoded.missing)
      },
      intervals: {
        profileTime: endIso,
        fluxWindow: { start: startIso, end: endIso },
        fluxSourceWindow: { start: sourceStartIso, end: endIso },
        ...(precipitation ? { precipitationWindow: { start: startIso, end: endIso }, precipitationSourceWindow: { start: sourceStartIso, end: endIso } } : {}),
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
