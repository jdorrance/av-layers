import type { LayerId, Manifest, ModelId, ModelPointer } from '@av/contracts';

export interface PaletteSummary {
  id: string;
  edges: readonly number[];
  colors: readonly string[];
  units: string;
  noLiftColor?: string;
  transparentBelow?: number;
  provisional?: boolean;
}

export interface CoverageSummary {
  id: string;
  hash: string;
  maskKey: string;
  maxZoom: number;
  tileBits?: readonly number[];
}

export interface LatestPayload {
  pointer: ModelPointer;
  manifest?: Manifest;
  templates?: Record<string, string>;
  bounds?: readonly [number, number, number, number];
  maxNativeZoom?: number;
  palettes?: readonly PaletteSummary[];
  coverage?: CoverageSummary;
  freshness?: { ageSeconds: number; expiresAt: string };
}

export type SampleStatus = 'valid' | 'no-usable-lift' | 'unavailable' | 'outside-domain';

export interface FrameSampleLayer {
  value: number | null;
  status: SampleStatus;
  support: number;
  interpolated: boolean;
}

export interface FrameSample {
  id: string;
  validTime: string;
  intervalStart: string;
  intervalEnd: string;
  layers: Record<string, FrameSampleLayer>;
}

export interface SamplePayload {
  model: string;
  buildId: string;
  lat: number;
  lon: number;
  method: unknown;
  source: unknown;
  coverage: unknown;
  expiresAt: string;
  frames: FrameSample[];
}

export interface PinnedBuild {
  baseUrl: string;
  model: ModelId;
  pointer: ModelPointer;
  manifest: Manifest;
  templates: Record<LayerId, string>;
  bounds: readonly [number, number, number, number];
  maxNativeZoom: number;
  palettes: readonly PaletteSummary[];
  coverage: CoverageSummary;
  fetchedAtMs: number;
  expiresAtMs: number;
}

export interface PinnedViewState {
  build: PinnedBuild;
  expired: boolean;
  remainingMs: number;
}

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

export function remainingMs(expiresAt: string, now = Date.now()): number {
  return Math.max(0, expiryTime(expiresAt) - now);
}

export function expiredView(build: PinnedBuild, now = Date.now()): boolean {
  return build.expiresAtMs <= now;
}

async function readError(response: Response): Promise<ApiError> {
  let code = `http-${response.status}`;
  let detail = response.statusText || `HTTP ${response.status}`;
  try {
    const body = (await response.json()) as { code?: unknown; type?: unknown; detail?: unknown; title?: unknown };
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

export class ApiClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(requireString(options.baseUrl, 'baseUrl'));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  private async getJson(path: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal
    });
    if (!response.ok) throw await readError(response);
    try {
      return await response.json();
    } catch {
      throw new InvalidApiResponseError('Response is not valid JSON');
    }
  }

  async latest(model: ModelId, options: RequestOptions & { requireLive?: boolean } = {}): Promise<PinnedBuild> {
    const raw = requireObject(await this.getJson(`/v1/models/${encodeURIComponent(model)}/latest?expand=manifest`, options.signal), 'latest response');
    const pointer = requireObject(raw.pointer, 'pointer') as unknown as ModelPointer;
    if (pointer.latestBuildId === undefined) throw new InvalidApiResponseError('pointer.latestBuildId is missing');
    if (pointer.model !== model) throw new InvalidApiResponseError('pointer model does not match request');
    const manifestRaw = requireObject(raw.manifest, 'manifest') as unknown as Manifest;
    if (manifestRaw.model !== model) throw new InvalidApiResponseError('manifest model does not match request');
    if (manifestRaw.buildId !== pointer.latestBuildId) throw new InvalidApiResponseError('manifest build is not the pinned pointer build');
    if (!Array.isArray(manifestRaw.frames) || manifestRaw.frames.length === 0) throw new InvalidApiResponseError('manifest frames are missing');
    if (!Array.isArray(manifestRaw.layers) || manifestRaw.layers.length === 0) throw new InvalidApiResponseError('manifest layers are missing');
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
    const palettes = Array.isArray(raw.palettes) ? (raw.palettes as PaletteSummary[]) : [];
    const coverage = requireObject(raw.coverage ?? manifestRaw.coverage, 'coverage') as unknown as CoverageSummary;
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
      fetchedAtMs: this.now(),
      expiresAtMs: expiryTime(manifestRaw.expiresAt)
    };
  }

  async sample(build: PinnedBuild, request: SampleRequest): Promise<SamplePayload> {
    if (build.expiresAtMs <= (request.now ?? this.now())) throw new ExpiredBuildError(build.manifest.expiresAt);
    if (!Number.isFinite(request.lat) || request.lat < -90 || request.lat > 90) throw new RangeError('lat out of range');
    if (!Number.isFinite(request.lon) || request.lon < -180 || request.lon > 180) throw new RangeError('lon out of range');
    const frames = request.frames ?? 'all';
    if (frames !== 'all') {
      if (frames.length === 0 || frames.length > 8) throw new RangeError('frames must contain 1..8 entries');
      if (new Set(frames).size !== frames.length) throw new RangeError('frames must be unique');
    }
    const layers = request.layers ?? build.manifest.layers;
    if (layers.length === 0 || layers.length > 3) throw new RangeError('layers must contain 1..3 entries');
    if (new Set(layers).size !== layers.length) throw new RangeError('layers must be unique');
    const params = new URLSearchParams({
      lat: String(request.lat),
      lon: String(request.lon),
      frame: frames === 'all' ? 'all' : frames.join(','),
      layers: layers.join(',')
    });
    const path = `/v1/models/${encodeURIComponent(build.model)}/runs/${encodeURIComponent(build.manifest.buildId)}/sample?${params.toString()}`;
    const raw = requireObject(await this.getJson(path, request.signal), 'sample response');
    if (build.expiresAtMs <= this.now()) throw new ExpiredBuildError(build.manifest.expiresAt);
    if (raw.model !== build.model) throw new InvalidApiResponseError('sample model does not match pinned build');
    if (raw.buildId !== build.manifest.buildId) throw new InvalidApiResponseError('sample build does not match pinned build');
    if (!Array.isArray(raw.frames)) throw new InvalidApiResponseError('sample frames are missing');
    const payload = raw as unknown as SamplePayload;
    for (const frame of payload.frames) {
      if (!Array.isArray(build.manifest.frames) || !build.manifest.frames.some(item => item.id === frame.id)) {
        throw new InvalidApiResponseError(`sample returned unknown frame ${frame.id}`);
      }
      for (const layer of layers) {
        if (!frame.layers || !(layer in frame.layers)) throw new InvalidApiResponseError(`sample frame ${frame.id} is missing ${layer}`);
      }
    }
    const sampleExpiry = typeof raw.expiresAt === 'string' ? raw.expiresAt : build.manifest.expiresAt;
    assertNotExpired(sampleExpiry, this.now());
    return payload;
  }
}

export function pinnedViewState(build: PinnedBuild, now = Date.now()): PinnedViewState {
  return {
    build,
    expired: build.expiresAtMs <= now,
    remainingMs: Math.max(0, build.expiresAtMs - now)
  };
}
