import { SUPPORT_MASK, getProvenanceReference, latestSchema, sampleResponseSchema, validateArtifactRecords, type LayerId, type Manifest, type ModelId } from './index.ts';
import type { PinnedBuild, SamplePayload, CoverageSummary } from './client-types.ts';

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface SampleRequest extends RequestOptions {
  lat: number;
  lon: number;
  frames?: 'all' | readonly string[];
  layers?: readonly LayerId[];
  now?: number;
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
    else if (typeof body.type === 'string') code = body.type;
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

function requireNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InvalidApiResponseError(`${name} must be a finite number`);
  return value;
}

async function readJsonBounded(response: Response, limit = 1024 * 1024, signal?: AbortSignal): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > limit) {
    await response.body?.cancel();
    throw new InvalidApiResponseError('Response exceeds byte budget');
  }
  if (!response.body) throw new InvalidApiResponseError('Response body is missing');
  const reader = response.body.getReader(), bytes = new Uint8Array(limit);
  const abort = () => { void reader.cancel(signal?.reason).catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  let total = 0, chunks = 0;
  try {
    signal?.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      if (++chunks > 65_536) { void reader.cancel().catch(() => {}); throw new InvalidApiResponseError('Response fragmentation exceeds budget'); }
      if (total + value.length > limit) { void reader.cancel().catch(() => {}); throw new InvalidApiResponseError('Response exceeds byte budget'); }
      bytes.set(value, total); total += value.length;
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder().decode(bytes.subarray(0, total))); }
  catch { throw new InvalidApiResponseError('Response is not valid JSON'); }
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly retryDelayMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(requireString(options.baseUrl, 'baseUrl'));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 10_000;
    this.retryDelayMs = options.retryDelayMs ?? 200;
    if (!(this.requestTimeoutMs > 0) || !Number.isFinite(this.requestTimeoutMs) || this.retryDelayMs < 0 || !Number.isFinite(this.retryDelayMs)) throw new RangeError('Invalid request timing budget');
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw signal.reason;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new ApiError(408, 'deadline-exceeded', 'Request deadline exceeded')), this.requestTimeoutMs);
    const canceled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
    const load = async () => {
      for (let attempt = 0; ; attempt++) {
        controller.signal.throwIfAborted();
        try {
          const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal });
          if (!response.ok) throw await readError(response, controller.signal);
          return await readJsonBounded(response, 1024 * 1024, controller.signal);
        } catch (error) {
          controller.signal.throwIfAborted();
          const retryable = error instanceof TypeError || (error instanceof ApiError && [502, 503, 504].includes(error.status));
          if (attempt > 0 || !retryable) throw error;
          await Promise.race([new Promise(resolve => setTimeout(resolve, this.retryDelayMs * (1 + Math.random() / 2))), canceled]);
        }
      }
    };
    try { return await Promise.race([load(), canceled]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }

  async latest(model: ModelId, options: RequestOptions & { requireLive?: boolean } = {}): Promise<PinnedBuild> {
    const parsed = latestSchema.safeParse(await this.getJson(`/v1/models/${encodeURIComponent(model)}/latest?expand=manifest`, options.signal));
    if (!parsed.success) throw new InvalidApiResponseError('latest response does not match contract schema');
    const raw = parsed.data;
    const pointer = raw.pointer;
    if (pointer.model !== model) throw new InvalidApiResponseError('pointer model does not match request');
    const manifestRaw = raw.manifest;
    if (!manifestRaw) throw new InvalidApiResponseError('expanded manifest is missing');
    if (manifestRaw.model !== model) throw new InvalidApiResponseError('manifest model does not match request');
    if (manifestRaw.buildId !== pointer.latestBuildId) throw new InvalidApiResponseError('manifest build is not the pinned pointer build');
    try { validateArtifactRecords(manifestRaw); getProvenanceReference(manifestRaw); } catch { throw new InvalidApiResponseError('manifest records or capabilities are inconsistent'); }
    const retained = pointer.retained.find(entry => entry.buildId === manifestRaw.buildId);
    if (!retained || retained.cycle !== manifestRaw.cycle || retained.expiresAt !== manifestRaw.expiresAt || retained.manifestKey !== `builds/${model}/${manifestRaw.buildId}/manifest.json`) throw new InvalidApiResponseError('manifest does not match retained entry');
    if (options.requireLive !== false) assertNotExpired(manifestRaw.expiresAt, this.now());
    const templateRaw = requireObject(raw.templates, 'templates');
    const templates = {} as Record<LayerId, string>;
    for (const layer of manifestRaw.layers) {
      templates[layer] = requireString(templateRaw[layer], `templates.${layer}`);
    }
    const boundsRaw = raw.bounds;
    if (!Array.isArray(boundsRaw) || boundsRaw.length !== 4 || boundsRaw.some(value => typeof value !== 'number')) {
      throw new InvalidApiResponseError('bounds must be four numbers');
    }
    const maxNativeZoom = requireNumber(raw.maxNativeZoom ?? manifestRaw.coverage.maxZoom, 'maxNativeZoom');
    if (JSON.stringify(boundsRaw) !== JSON.stringify(manifestRaw.descriptors.bounds) || maxNativeZoom !== manifestRaw.coverage.maxZoom) throw new InvalidApiResponseError('display bounds or zoom disagree with pinned manifest');
    const palettes = manifestRaw.descriptors.palettes;
    const coverage: CoverageSummary = raw.coverage ?? manifestRaw.coverage;
    for (const key of Object.keys(manifestRaw.coverage) as (keyof Manifest['coverage'])[]) {
      if (coverage[key] !== manifestRaw.coverage[key]) throw new InvalidApiResponseError('expanded coverage disagrees with pinned manifest');
    }
    if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0 || maxNativeZoom > 8) throw new InvalidApiResponseError('Unsupported native tile zoom');
    if (coverage.tileBits) {
      const count = (4 ** (maxNativeZoom + 1) - 1) / 3;
      const paddingMask = count % 8 ? ~((1 << (count % 8)) - 1) : 0;
      if (coverage.tileBits.length !== Math.ceil(count / 8) || coverage.tileBits.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255) || (coverage.tileBits.at(-1)! & paddingMask) !== 0) throw new InvalidApiResponseError('Invalid expanded coverage tile bitset');
    }
    return {
      baseUrl: this.baseUrl,
      model,
      pointer,
      manifest: manifestRaw,
      templates,
      bounds: boundsRaw as [number, number, number, number],
      maxNativeZoom,
      palettes,
      coverage,
      freshness: raw.freshness,
      fetchedAtMs: this.now(),
      expiresAtMs: expiryTime(manifestRaw.expiresAt)
    };
  }

  async sample(build: PinnedBuild, request: SampleRequest): Promise<SamplePayload> {
    if (build.expiresAtMs <= (request.now ?? this.now())) throw new ExpiredBuildError(build.manifest.expiresAt);
    if (!Number.isFinite(request.lat) || request.lat < -90 || request.lat > 90) throw new RangeError('lat out of range');
    if (!Number.isFinite(request.lon) || request.lon < -180 || request.lon > 180) throw new RangeError('lon out of range');
    const frames = request.frames ?? 'all';
    const expectedFrames = frames === 'all' ? build.manifest.frames.map(frame => frame.id) : [...frames];
    const layers = request.layers ?? build.manifest.layers;
    if (!expectedFrames.length || new Set(expectedFrames).size !== expectedFrames.length) throw new RangeError('frames must be non-empty and unique');
    if (!layers.length || new Set(layers).size !== layers.length) throw new RangeError('layers must be non-empty and unique');
    if (expectedFrames.some(id => !build.manifest.frames.some(frame => frame.id === id))) throw new RangeError('unknown frame');
    if (layers.some(layer => !build.manifest.layers.includes(layer))) throw new RangeError('unknown layer');
    if (expectedFrames.length * layers.length > build.manifest.descriptors.maxSampleValues) throw new RangeError(`select at most ${build.manifest.descriptors.maxSampleValues} frame/layer values`);
    const params = new URLSearchParams({
      lat: String(request.lat),
      lon: String(request.lon),
      frame: frames === 'all' ? 'all' : frames.join(','),
      layers: layers.join(',')
    });
    const path = `/v1/models/${encodeURIComponent(build.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/sample?${params.toString()}`;
    const raw = await this.getJson(path, request.signal);
    if (build.expiresAtMs <= this.now()) throw new ExpiredBuildError(build.manifest.expiresAt);
    const parsed = sampleResponseSchema.safeParse(raw);
    if (!parsed.success) throw new InvalidApiResponseError('sample response does not match contract schema');
    const payload = parsed.data;
    if (payload.model !== build.model || payload.buildId !== build.manifest.buildId) {
      throw new InvalidApiResponseError('sample does not match pinned build');
    }
    if (payload.lat !== request.lat || payload.lon !== request.lon) throw new InvalidApiResponseError('sample coordinates do not match requested point');
    if (payload.expiresAt !== build.manifest.expiresAt || payload.method.id !== build.manifest.method.id || payload.method.hash !== build.manifest.method.hash) {
      throw new InvalidApiResponseError('sample method or expiry does not match pinned build');
    }
    for (const key of Object.keys(build.manifest.coverage) as (keyof Manifest['coverage'])[]) {
      if (JSON.stringify(payload.coverage[key]) !== JSON.stringify(build.manifest.coverage[key])) throw new InvalidApiResponseError('sample coverage does not match pinned build');
    }
    for (const key of ['provider', 'provenanceKey', 'provenanceSha256'] as const) {
      if (payload.source[key] !== build.manifest.source[key]) throw new InvalidApiResponseError('sample source does not match pinned build');
    }
    const receivedFrames = new Set(payload.frames.map(frame => frame.id));
    if (receivedFrames.size !== payload.frames.length || receivedFrames.size !== expectedFrames.length || expectedFrames.some(id => !receivedFrames.has(id))) {
      throw new InvalidApiResponseError('sample frames do not match the requested selection');
    }
    for (const frame of payload.frames) {
      const expected = build.manifest.frames.find(item => item.id === frame.id)!;
      if (frame.validTime !== expected.validTime || frame.intervalStart !== expected.intervalStart || frame.intervalEnd !== expected.intervalEnd) {
        throw new InvalidApiResponseError(`sample frame ${frame.id} times do not match pinned build`);
      }
      if (Object.keys(frame.layers).length !== layers.length || layers.some(layer => !Object.hasOwn(frame.layers, layer))) {
        throw new InvalidApiResponseError(`sample frame ${frame.id} layers do not match the requested selection`);
      }
      for (const layer of layers) {
        const cell = frame.layers[layer], spec = build.manifest.descriptors.layers[layer];
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
    return payload;
  }
}
