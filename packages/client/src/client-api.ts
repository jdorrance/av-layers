import { DEFAULT_REQUEST_TIMEOUT_MS } from '@av/contracts/format';
import { gridToGeographic } from '@av/contracts/geometry';
import { renderedLayers, SUPPORT_MASK, type LayerId } from '@av/contracts/layers';
import { getProvenanceReference, latestV5Schema, sampleResponseV5Schema, type ModelId } from '@av/contracts/publication';
import { estimateProfileResponseBytes, MAX_POINT_RESPONSE_BYTES, MAX_SAMPLE_POINTS, multiPointSampleResponseSchema,
  profileResponseSchema, type MultiPointSampleResponse, type ProfileResponse } from '@av/contracts/point-products';
import type { GeoPoint, PinnedBuild, SamplePayload, PointSeriesLoader } from './client-types.ts';
import { createPointSeriesLoader } from './client-point.ts';

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SampleRequest extends RequestOptions {
  lat: number;
  lon: number;
  /** Defaults to the first published frame. */
  frames?: 'all' | readonly string[];
  layers?: readonly LayerId[];
  now?: number;
}

export interface MultiPointSampleRequest extends Omit<SampleRequest, 'lat' | 'lon'> {
  points: readonly GeoPoint[];
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}

export class ExpiredBuildError extends Error {
  constructor(readonly expiresAt: string) {
    super(`Build expired at ${expiresAt}`);
    this.name = 'ExpiredBuildError';
  }
}

export class InvalidApiResponseError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'InvalidApiResponseError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  /** Observe completed JSON transport requests, including any retry and body read. */
  onMetric?: (metric: ApiClientMetric) => void;
}

export interface ApiClientMetric {
  route: 'latest' | 'sample' | 'samples' | 'profile';
  elapsedMs: number;
  attempts: number;
  outcome: 'success' | 'failure' | 'aborted';
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

export function expiryTime(expiresAt: string): number {
  const value = Date.parse(expiresAt);
  if (!Number.isFinite(value)) throw new InvalidApiResponseError(`Invalid expiry timestamp: ${expiresAt}`);
  return value;
}

export function assertNotExpired(expiresAt: string, now = Date.now()): void {
  if (expiryTime(expiresAt) <= now) throw new ExpiredBuildError(expiresAt);
}

async function readError(response: Response, signal?: AbortSignal): Promise<ApiError> {
  let code = `http-${response.status}`;
  let detail = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await readJsonBounded(response, 64 * 1024, signal)) as { code?: unknown; type?: unknown; detail?: unknown; title?: unknown };
    if (typeof body.code === 'string') code = body.code;
    else if (typeof body.title === 'string') code = body.title;
    else if (typeof body.type === 'string') code = body.type.replace(/^urn:windy-av:/, '');
    if (typeof body.detail === 'string') detail = body.detail;
    else if (typeof body.title === 'string') detail = body.title;
  } catch {
    return new ApiError(response.status, code, detail);
  }
  return new ApiError(response.status, code, detail);
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new InvalidApiResponseError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new InvalidApiResponseError(`${name} must be a non-empty string`);
  return value;
}

async function readJsonBounded(response: Response, limit = MAX_POINT_RESPONSE_BYTES, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    void response.body?.cancel().catch(() => {});
    throw new InvalidApiResponseError('Response exceeds byte budget');
  }
  if (!response.body) throw new InvalidApiResponseError('Response body is missing');
  const reader = response.body.getReader();
  const declaredBytes = Number(length);
  let bytes = new Uint8Array(Number.isSafeInteger(declaredBytes) && declaredBytes > 0 ? declaredBytes : Math.min(1024, limit));
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  let total = 0, chunks = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (++chunks > 65_536) { void reader.cancel().catch(() => {}); throw new InvalidApiResponseError('Response fragmentation exceeds budget'); }
      if (total + value.length > limit) { void reader.cancel().catch(() => {}); throw new InvalidApiResponseError('Response exceeds byte budget'); }
      if (total + value.length > bytes.length) {
        const grown = new Uint8Array(Math.min(limit, Math.max(total + value.length, bytes.length * 2)));
        grown.set(bytes.subarray(0, total));
        bytes = grown;
      }
      bytes.set(value, total);
      total += value.length;
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total))); }
  catch { throw new InvalidApiResponseError('Response is not valid JSON'); }
}

function validatePoint(point: GeoPoint): void {
  if (!Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) throw new RangeError('lat out of range');
  if (!Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) throw new RangeError('lon out of range');
}

function sampleSelection(build: PinnedBuild, request: Pick<SampleRequest, 'frames' | 'layers'>, defaults = build.manifest.layers, points = 1, scalarLimit = true) {
  const frames = request.frames ?? [build.manifest.frames[0]!.id];
  const expectedFrames = frames === 'all' ? build.manifest.frames.map(frame => frame.id) : [...frames];
  const layers = request.layers ?? defaults;
  if (!expectedFrames.length || new Set(expectedFrames).size !== expectedFrames.length) throw new RangeError('frames must be non-empty and unique');
  if (!layers.length || new Set(layers).size !== layers.length) throw new RangeError('layers must be non-empty and unique');
  if (expectedFrames.some(id => !build.manifest.frames.some(frame => frame.id === id))) throw new RangeError('unknown frame');
  if (layers.some(layer => !build.manifest.layers.includes(layer))) throw new RangeError('unknown layer');
  if (scalarLimit && points * expectedFrames.length * layers.length > build.manifest.descriptors.maxSampleValues) throw new RangeError(`select at most ${build.manifest.descriptors.maxSampleValues} point/frame/layer values`);
  return { expectedFrames, layers, frameQuery: frames === 'all' ? 'all' : frames.join(',') };
}

function pointPath(build: PinnedBuild, route: 'sample' | 'samples' | 'profile'): string {
  return `/v1/models/${encodeURIComponent(build.manifest.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/${route}`;
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly onMetric: ApiClientOptions['onMetric'];

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(requireString(options.baseUrl, 'baseUrl'));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.onMetric = options.onMetric;
    if (!(this.requestTimeoutMs > 0) || !Number.isFinite(this.requestTimeoutMs) || this.retryDelayMs < 0 || !Number.isFinite(this.retryDelayMs)) throw new RangeError('Invalid request timing budget');
  }

  private async getJson(route: ApiClientMetric['route'], path: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    const started = this.onMetric ? performance.now() : 0;
    let attempts = 0, outcome: ApiClientMetric['outcome'] = 'failure';
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ApiError(408, 'deadline-exceeded', 'Request deadline exceeded')), this.requestTimeoutMs);
    const canceled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    const load = async () => {
      for (;;) {
        controller.signal.throwIfAborted();
        attempts++;
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
          if (!response.ok) throw await readError(response, controller.signal);
          return await readJsonBounded(response, MAX_POINT_RESPONSE_BYTES, controller.signal);
        } catch (error) {
          controller.signal.throwIfAborted();
          const retryable = error instanceof TypeError || (error instanceof ApiError && [502, 503, 504].includes(error.status));
          if (attempts >= 2 || !retryable) throw error;
          await Promise.race([new Promise(resolve => setTimeout(resolve, this.retryDelayMs * (1 + Math.random() / 2))), canceled]);
        }
      }
    };
    try {
      const result = await Promise.race([load(), canceled]);
      outcome = 'success';
      return result;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      try {
        this.onMetric?.({ route, attempts, elapsedMs: performance.now() - started,
          outcome: signal?.aborted && outcome === 'failure' ? 'aborted' : outcome });
      } catch { /* Observer failures leave the request result intact. */ }
    }
  }

  async latest(model: ModelId, options: RequestOptions & { requireLive?: boolean } = {}): Promise<PinnedBuild> {
    const parsed = latestV5Schema.safeParse(await this.getJson('latest', `/v1/models/${encodeURIComponent(model)}/latest?expand=manifest`, options.signal));
    if (!parsed.success) throw new InvalidApiResponseError('latest response does not match contract schema');
    const raw = parsed.data;
    const pointer = raw.pointer;
    if (pointer.model !== model) throw new InvalidApiResponseError('pointer model does not match request');
    const manifestRaw = raw.manifest;
    if (!manifestRaw) throw new InvalidApiResponseError('expanded manifest is missing');
    if (manifestRaw.model !== model) throw new InvalidApiResponseError('manifest model does not match request');
    if (manifestRaw.buildId !== pointer.latestBuildId) throw new InvalidApiResponseError('manifest build is not the pinned pointer build');
    try { getProvenanceReference(manifestRaw); } catch { throw new InvalidApiResponseError('manifest provenance is inconsistent'); }
    const retained = pointer.retained.find(entry => entry.buildId === manifestRaw.buildId);
    if (!retained || retained.cycle !== manifestRaw.cycle || retained.expiresAt !== manifestRaw.expiresAt || retained.manifestKey !== `builds/${model}/${manifestRaw.buildId}/manifest.json`) throw new InvalidApiResponseError('manifest does not match retained entry');
    if (options.requireLive !== false) assertNotExpired(manifestRaw.expiresAt, this.now());
    const templateRaw = requireObject(raw.templates, 'templates');
    const templates: PinnedBuild['templates'] = {};
    for (const layer of renderedLayers(manifestRaw.layers, manifestRaw.descriptors.layers)) {
      templates[layer] = requireString(templateRaw[layer], `templates.${layer}`);
    }
    return {
      manifest: manifestRaw,
      templates,
      expiresAtMs: expiryTime(manifestRaw.expiresAt)
    };
  }

  pointSeries(build: PinnedBuild, point: GeoPoint): PointSeriesLoader {
    validatePoint(point);
    const location = { ...point };
    const pinned = build.manifest, { model, buildId, cycle, expiresAt } = pinned;
    const methodId = pinned.method.id, methodHash = pinned.method.hash;
    return createPointSeriesLoader(build,
      (frames, layers, signal) => this.sample(build, { ...location, frames, layers, signal }),
      (frames, layers, signal) => this.profile(build, { ...location, frames, layers, signal }),
      () => {
        if (build.manifest !== pinned || pinned.model !== model || pinned.buildId !== buildId || pinned.cycle !== cycle || pinned.expiresAt !== expiresAt
          || pinned.method.id !== methodId || pinned.method.hash !== methodHash) throw new InvalidApiResponseError('Point series pinned build changed');
        assertNotExpired(expiresAt, this.now());
      });
  }

  async sample(build: PinnedBuild, request: SampleRequest): Promise<SamplePayload> {
    if (build.expiresAtMs <= (request.now ?? this.now())) throw new ExpiredBuildError(build.manifest.expiresAt);
    validatePoint(request);
    const { expectedFrames, layers, frameQuery } = sampleSelection(build, request);
    const params = new URLSearchParams({
      lat: String(request.lat),
      lon: String(request.lon),
      frame: frameQuery,
      layers: layers.join(',')
    });
    const path = `${pointPath(build, 'sample')}?${params}`;
    const raw = await this.getJson('sample', path, request.signal);
    if (build.expiresAtMs <= this.now()) throw new ExpiredBuildError(build.manifest.expiresAt);
    const parsed = sampleResponseV5Schema.safeParse(raw);
    if (!parsed.success) throw new InvalidApiResponseError('sample response does not match contract schema');
    const payload = parsed.data;
    this.validateSampleSurfaces(this.sampleSurfaces(build), payload);
    this.validateSample(build, request, expectedFrames, layers, payload);
    return payload;
  }

  async samples(build: PinnedBuild, request: MultiPointSampleRequest): Promise<MultiPointSampleResponse> {
    assertNotExpired(build.manifest.expiresAt, request.now ?? this.now());
    if (!request.points.length || request.points.length > MAX_SAMPLE_POINTS) throw new RangeError(`Select 1–${MAX_SAMPLE_POINTS} points`);
    for (const point of request.points) validatePoint(point);
    const { expectedFrames, layers, frameQuery } = sampleSelection(build, request, build.manifest.layers, request.points.length);
    const params = new URLSearchParams({ points: request.points.map(point => `${point.lat},${point.lon}`).join(';'), frame: frameQuery, layers: layers.join(',') });
    const raw = await this.getJson('samples', `${pointPath(build, 'samples')}?${params}`, request.signal);
    assertNotExpired(build.manifest.expiresAt, this.now());
    const parsed = multiPointSampleResponseSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidApiResponseError('multi-point sample response does not match contract schema');
    const payload = parsed.data;
    if (payload.model !== build.manifest.model || payload.buildId !== build.manifest.buildId || payload.expiresAt !== build.manifest.expiresAt || payload.points.length !== request.points.length) {
      throw new InvalidApiResponseError('multi-point sample does not match pinned build or requested points');
    }
    const surfaces = this.sampleSurfaces(build);
    for (const { index, sample } of payload.points) {
      this.validateSampleSurfaces(surfaces, sample);
      this.validateSample(build, request.points[index], expectedFrames, layers, sample);
    }
    return payload;
  }

  async profile(build: PinnedBuild, request: SampleRequest): Promise<ProfileResponse> {
    assertNotExpired(build.manifest.expiresAt, request.now ?? this.now());
    validatePoint(request);
    const native = build.manifest.surfaces.find(surface => surface.kind === 'native');
    if (!native?.profiles) throw new RangeError('Build has no native profiles');
    const { expectedFrames, layers, frameQuery } = sampleSelection(build, request, native.layers, 1, false);
    if (layers.some(layer => !native.layers.includes(layer))) throw new RangeError('Profile layers must belong to the native surface');
    if (estimateProfileResponseBytes(expectedFrames.length, native.profiles.levelCount, layers.length) > MAX_POINT_RESPONSE_BYTES) throw new RangeError('Selected profile response exceeds byte budget');
    const params = new URLSearchParams({ lat: String(request.lat), lon: String(request.lon), frame: frameQuery, layers: layers.join(',') });
    const raw = await this.getJson('profile', `${pointPath(build, 'profile')}?${params}`, request.signal);
    assertNotExpired(build.manifest.expiresAt, this.now());
    const parsed = profileResponseSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidApiResponseError('profile response does not match contract schema');
    const payload = parsed.data;
    if (payload.cycle !== build.manifest.cycle || payload.createdAt !== build.manifest.createdAt) throw new InvalidApiResponseError('profile run timestamps differ from pinned build');
    const cell = payload.cell;
    if (cell) {
      const position = gridToGeographic(native.grid, cell.index % native.grid.width, Math.floor(cell.index / native.grid.width));
      if (cell.surfaceId !== native.id || cell.index >= native.grid.width * native.grid.height || !position || Math.abs(position.lat - cell.lat) > 1e-6 || Math.abs(position.lon - cell.lon) > 1e-6) {
        throw new InvalidApiResponseError('profile cell differs from the pinned native grid');
      }
    }
    this.validateSample(build, request, expectedFrames, layers, payload);
    for (const frame of payload.frames) {
      if (frame.profile.levels.length > native.profiles.levelCount || (cell === null ? frame.profile.status !== 'outside-domain' || frame.profile.modelTerrainM !== null : frame.profile.status === 'outside-domain') ||
        layers.some(layer => frame.layers[layer].interpolated || (cell === null ? frame.layers[layer].status !== 'outside-domain' : frame.layers[layer].status === 'outside-domain'))) {
        throw new InvalidApiResponseError('profile coverage or levels differ from selected native cell');
      }
    }
    return payload;
  }

  private sampleSurfaces(build: PinnedBuild): string {
    return JSON.stringify(build.manifest.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })));
  }

  private validateSampleSurfaces(expected: string, payload: SamplePayload): void {
    if (JSON.stringify(payload.surfaces) !== expected) throw new InvalidApiResponseError('sample surfaces do not match pinned build');
  }

  private validateSample(build: PinnedBuild, request: GeoPoint, expectedFrames: readonly string[], layers: readonly LayerId[], payload: Omit<SamplePayload, 'version' | 'surfaces'>): void {
    if (payload.model !== build.manifest.model || payload.buildId !== build.manifest.buildId) {
      throw new InvalidApiResponseError('sample does not match pinned build');
    }
    if (payload.lat !== request.lat || payload.lon !== request.lon) throw new InvalidApiResponseError('sample coordinates do not match requested point');
    if (payload.expiresAt !== build.manifest.expiresAt || payload.method.id !== build.manifest.method.id || payload.method.hash !== build.manifest.method.hash) {
      throw new InvalidApiResponseError('sample method or expiry does not match pinned build');
    }
    for (const key of ['provider', 'provenanceKey', 'provenanceSha256'] as const) {
      if (payload.source[key] !== build.manifest.source[key]) throw new InvalidApiResponseError('sample source does not match pinned build');
    }
    const receivedFrames = new Set(payload.frames.map(frame => frame.id));
    if (receivedFrames.size !== payload.frames.length || receivedFrames.size !== expectedFrames.length || expectedFrames.some(id => !receivedFrames.has(id))) {
      throw new InvalidApiResponseError('sample frames do not match the requested selection');
    }
    const expectedById = new Map(build.manifest.frames.map(frame => [frame.id, frame]));
    const owners = layers.map(layer => ({ layer, spec: build.manifest.descriptors.layers[layer],
      surfaceId: build.manifest.surfaces.find(surface => surface.layers.includes(layer))?.id }));
    for (const frame of payload.frames) {
      const expected = expectedById.get(frame.id)!;
      if (frame.validTime !== expected.validTime || frame.intervalStart !== expected.intervalStart || frame.intervalEnd !== expected.intervalEnd) {
        throw new InvalidApiResponseError(`sample frame ${frame.id} times do not match pinned build`);
      }
      if (Object.keys(frame.layers).length !== layers.length || layers.some(layer => !Object.hasOwn(frame.layers, layer))) {
        throw new InvalidApiResponseError(`sample frame ${frame.id} layers do not match the requested selection`);
      }
      for (const { layer, spec, surfaceId } of owners) {
        const cell = frame.layers[layer];
        if (cell.surfaceId !== surfaceId) throw new InvalidApiResponseError(`sample frame ${frame.id} has an invalid ${layer} surface`);
        if (cell.support < 0 || cell.support > SUPPORT_MASK || (cell.support & ~SUPPORT_MASK) !== 0 || (!spec.supportsLiftFlags && cell.support !== 0) ||
            (cell.status === 'valid' && cell.value === null) ||
            (cell.status === 'no-usable-lift' && (!spec.supportsNoLift || cell.value !== spec.noLiftSampleValue)) ||
            ((cell.status === 'unavailable' || cell.status === 'outside-domain') && cell.value !== null) ||
            (cell.status === 'outside-domain' && cell.support !== 0)) {
          throw new InvalidApiResponseError(`sample frame ${frame.id} has inconsistent ${layer} value/status/support`);
        }
      }
    }
    assertNotExpired(payload.expiresAt, this.now());
  }
}
