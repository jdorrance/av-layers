import type { z } from 'zod';
import {
  LAYERS,
  MODEL_IDS,
  latestSchema,
  normalizeLon,
  paletteBinLabel,
  sampleValueSchema,
  type FreshnessSummary,
  type LayerId,
  type Manifest,
  type ModelId,
  type ModelPointer,
  type SampleStatus
} from './index.ts';

export { normalizeLon, paletteBinLabel, type SampleStatus };

export interface PaletteSummary {
  id: string;
  edges: readonly number[];
  colors: readonly string[];
  units: string;
  noLiftColor?: string;
  transparentBelow?: number;
  provisional?: boolean;
}

export function noLiftLabel(color: string): string {
  return color.toLowerCase() === '#00000000' ? 'no usable lift (transparent)' : 'no usable lift';
}

export function paletteNoteText(palette: PaletteSummary): string | null {
  if (!palette.provisional && palette.transparentBelow === undefined) return null;
  if (palette.transparentBelow === undefined) return 'Provisional palette.';
  return `Transparent below ${palette.transparentBelow} ${palette.units}; provisional palette.`;
}

export function activePalettes(palettes: readonly PaletteSummary[], layerId: LayerId | string | null): readonly PaletteSummary[] {
  if (!layerId || !(layerId in LAYERS)) return palettes;
  const targetId = LAYERS[layerId as LayerId].palette;
  const matched = palettes.filter(palette => palette.id === targetId);
  return matched.length > 0 ? matched : palettes;
}

export interface CoverageSummary {
  id: string;
  hash: string;
  maskKey: string;
  maxZoom: number;
  tileBits?: readonly number[];
}

export type LatestPayload = z.infer<typeof latestSchema>;

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
  freshness?: FreshnessSummary;
  fetchedAtMs: number;
  expiresAtMs: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export function normalizePoint(lat: number, lon: number): GeoPoint {
  return { lat, lon: normalizeLon(lon) };
}

export function samePoint(a: GeoPoint | null | undefined, b: GeoPoint | null | undefined): boolean {
  if (!a || !b) return false;
  return Math.abs(a.lat - b.lat) <= 1e-9 && Math.abs(a.lon - b.lon) <= 1e-9;
}

export function coverageSummaryText(build: PinnedBuild): string {
  return `Coverage ${build.coverage.id}: ${build.bounds[1]}° to ${build.bounds[3]}° lat (land + 50 km coastal buffer; excludes RUS, ATA, GRL)`;
}

export function buildDiagnosticRows(build: PinnedBuild): Array<[string, string]> {
  const manifest = build.manifest;
  const grid = manifest.grid;
  const source = manifest.source as Record<string, unknown>;
  const model = typeof source.model === 'string' ? source.model : build.model.toUpperCase();
  const native = typeof source.nativeResolutionDeg === 'number' ? `${source.nativeResolutionDeg}° native columns` : 'native model columns';
  const validTimes = manifest.frames.map(f => Date.parse(f.validTime)).filter(Number.isFinite);
  const horizonEnd = validTimes.length > 0 ? new Date(Math.max(...validTimes)).toISOString() : manifest.cycle;
  const rows: Array<[string, string]> = [
    ['Build', manifest.buildId],
    ['Cycle', manifest.cycle],
    ['Horizon', `${manifest.frames[0]?.validTime ?? manifest.cycle} → ${horizonEnd}`],
    ['Method', `${manifest.method.id} · ${manifest.method.hash.slice(0, 12)}…`],
    ['Source', `${model} · ${native}`],
    ['Display', `z0–${build.maxNativeZoom} · 256 px raster · overzoomed above z${build.maxNativeZoom}`],
    ['Grid', `${grid.width} × ${grid.height} · ${grid.dx}° × ${Math.abs(grid.dy)}° EPSG:4326`],
    ['Coverage', `${build.coverage.id} · ${build.bounds[1]}° to ${build.bounds[3]}° lat · excludes RUS, ATA, GRL`],
    ['MSL / AGL', 'MSL uses model terrain + usable AGL; AGL uses the same model terrain, not a high-resolution DEM'],
    ['Method caveat', '1.2 m/s sink threshold; PBL closure only for the first layer; parcel-crossing/profile-top/PBL support flags are explicit'],
    ['Coverage caveat', 'Coastal and exclusion borders can differ from the true coastline by about one cell diagonal'],
    ['Expires', manifest.expiresAt]
  ];
  if (typeof source.provenanceUrl === 'string') {
    rows.push(['Provenance', source.provenanceUrl]);
  } else if (typeof source.provenanceKey === 'string') {
    rows.push(['Provenance', `${source.provenanceKey}${typeof source.provenanceSha256 === 'string' ? ` (${source.provenanceSha256.slice(0, 12)}…)` : ''}`]);
  }
  return rows;
}

export function formatSampleStatus(sample: FrameSampleLayer): string {
  if (sample.status === 'valid') return sample.value === null ? '—' : String(sample.value);
  if (sample.status === 'no-usable-lift') return 'no lift';
  if (sample.status === 'unavailable') return 'unavailable';
  return 'outside coverage';
}

export function formatSupportFlags(support: number): string {
  const flags: string[] = [];
  if (support & 4) flags.push('parcel');
  if (support & 8) flags.push('top');
  if (support & 16) flags.push('PBL');
  return flags.join('+') || '—';
}

export function formatSeriesSummary(
  payload: { frames: readonly FrameSample[]; method: unknown; coverage: unknown; expiresAt: string },
  layers: readonly string[],
  point: GeoPoint
): string {
  const method = payload.method as { id?: unknown } | null;
  const coverage = payload.coverage as { id?: unknown } | null;
  return `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)} · ${payload.frames.length} frames × ${layers.length} layers · method ${String(method?.id ?? 'unknown')} · coverage ${String(coverage?.id ?? 'unknown')} · expires ${payload.expiresAt}`;
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
    const parsed = latestSchema.safeParse(await this.getJson(`/v1/models/${encodeURIComponent(model)}/latest?expand=manifest`, options.signal));
    if (!parsed.success) throw new InvalidApiResponseError('latest response does not match contract schema');
    const raw = parsed.data;
    const pointer = raw.pointer;
    if (pointer.model !== model) throw new InvalidApiResponseError('pointer model does not match request');
    const manifestRaw = raw.manifest;
    if (!manifestRaw) throw new InvalidApiResponseError('expanded manifest is missing');
    if (manifestRaw.model !== model) throw new InvalidApiResponseError('manifest model does not match request');
    if (manifestRaw.buildId !== pointer.latestBuildId) throw new InvalidApiResponseError('manifest build is not the pinned pointer build');
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
    const palettes = raw.palettes ?? [];
    const coverage = raw.coverage ?? manifestRaw.coverage;
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
    if (typeof raw.lat === 'number' && Math.abs(raw.lat - request.lat) > 1e-6) {
      throw new InvalidApiResponseError('sample latitude does not match requested point');
    }
    if (typeof raw.lon === 'number' && Math.abs(raw.lon - request.lon) > 1e-6) {
      throw new InvalidApiResponseError('sample longitude does not match requested point');
    }
    if (!Array.isArray(raw.frames)) throw new InvalidApiResponseError('sample frames are missing');
    const payload = raw as unknown as SamplePayload;
    for (const frame of payload.frames) {
      if (!Array.isArray(build.manifest.frames) || !build.manifest.frames.some(item => item.id === frame.id)) {
        throw new InvalidApiResponseError(`sample returned unknown frame ${frame.id}`);
      }
      for (const layer of layers) {
        const cell = frame.layers?.[layer];
        if (!cell) throw new InvalidApiResponseError(`sample frame ${frame.id} is missing ${layer}`);
        if (!sampleValueSchema.safeParse(cell).success) {
          throw new InvalidApiResponseError(`sample frame ${frame.id} has invalid ${layer} value`);
        }
      }
    }
    const sampleExpiry = typeof raw.expiresAt === 'string' ? raw.expiresAt : build.manifest.expiresAt;
    assertNotExpired(sampleExpiry, this.now());
    return payload;
  }
}

export interface FrameLike {
  id: string;
  validTime: string;
  intervalStart: string;
  intervalEnd: string;
}

export interface DatasetRange {
  startMs: number;
  endMs: number;
}

export interface FrameBadge {
  kind: 'explicit' | 'in-frame' | 'off-frame' | 'expired';
  text: string;
}

export const HOST_MATCH_TOLERANCE_MS = 1000;

export function frameTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid frame timestamp: ${value}`);
  return parsed;
}

export function selectExplicitFrame<T extends FrameLike>(frames: readonly T[], id: string): T | null {
  return frames.find(frame => frame.id === id) ?? null;
}

export function matchHostFrame<T extends FrameLike>(frames: readonly T[], timestampMs: number, toleranceMs = HOST_MATCH_TOLERANCE_MS): T | null {
  if (!Number.isFinite(timestampMs)) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = Math.abs(frameTime(frame.validTime) - timestampMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function datasetRange(frames: readonly FrameLike[]): DatasetRange | null {
  if (frames.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const intervalStart = Date.parse(frame.intervalStart);
    const intervalEnd = Date.parse(frame.intervalEnd);
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return null;
    start = Math.min(start, intervalStart);
    end = Math.max(end, intervalEnd);
  }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { startMs: start, endMs: end } : null;
}

export function syncTimestampForFrame(frame: FrameLike, range: DatasetRange | null): number | null {
  if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.endMs < range.startMs) return null;
  const timestamp = frameTime(frame.validTime);
  if (timestamp < range.startMs || timestamp > range.endMs) return null;
  return timestamp;
}

export function frameBadge(selected: FrameLike | null, hostMatch: FrameLike | null, hostTimestampMs: number | null, expired = false): FrameBadge {
  if (expired) return { kind: 'expired', text: 'Build expired — overlay removed' };
  if (!selected) return { kind: 'explicit', text: 'No frame selected' };
  if (hostMatch && hostMatch.id === selected.id) {
    return { kind: 'in-frame', text: `Host frame ${selected.id} · ${selected.validTime}` };
  }
  if (hostTimestampMs !== null && !hostMatch) {
    const time = new Date(hostTimestampMs).toISOString();
    return { kind: 'off-frame', text: `Host time ${time} is off-frame — keeping ${selected.id}` };
  }
  return { kind: 'explicit', text: `Explicit frame ${selected.id} · ${selected.validTime}` };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function watchBuildExpiry(expiresAtMs: number, expire: () => void, targets: EventTarget[]): () => void {
  if (!Number.isFinite(expiresAtMs)) throw new RangeError('Invalid expiry deadline');
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (fired) return;
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      fired = true;
      expire();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(check, Math.min(2_147_000_000, remaining));
  };
  const events = ['visibilitychange', 'pageshow', 'focus'];
  for (const target of targets) for (const event of events) target.addEventListener(event, check);
  check();
  return () => {
    fired = true;
    if (timer !== null) clearTimeout(timer);
    for (const target of targets) for (const event of events) target.removeEventListener(event, check);
  };
}

/** Forecast usefulness is independent of how long its artifacts are retained. */
export function forecastHorizonNotice(manifest: Pick<Manifest, 'frames'>, nowMs = Date.now()): string | null {
  if (manifest.frames.length === 0) return null;
  const endMs = Math.max(...manifest.frames.map(frame => frameTime(frame.validTime)));
  return nowMs >= endMs
    ? `Forecast ended at ${new Date(endMs).toISOString()} — update overdue. Showing historical forecast.`
    : null;
}

export function buildAgeMs(createdAt: string, now = Date.now()): number {
  return Math.max(0, now - frameTime(createdAt));
}

export const PREVIEW_TILE_SIZE = 256;
export const DEFAULT_OPACITY = 0.5;
export const OVERLAY_SOURCE_ID = 'av-overlay';
export const OVERLAY_LAYER_ID = 'av-overlay-raster';

export interface PreviewRasterSource {
  type: 'raster';
  tiles: string[];
  tileSize: number;
  minzoom: number;
  maxzoom: number;
  attribution: string;
}

export interface PreviewRasterLayer {
  id: string;
  type: 'raster';
  source: string;
  paint: Record<string, number>;
}

export interface WindyTileOptions {
  tileSize: number;
  detectRetina: boolean;
  minZoom: number;
  maxZoom: number;
  maxNativeZoom: number;
  opacity: number;
  attribution: string;
  minNativeZoom: number;
}

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPACITY;
  return Math.min(1, Math.max(0, value));
}

export function frameTileUrl(template: string, frame: string): string {
  if (!template.includes('{frame}')) throw new RangeError('tile template is missing {frame}');
  if (!template.includes('{z}') || !template.includes('{x}') || !template.includes('{y}')) {
    throw new RangeError('tile template is missing {z}/{x}/{y}');
  }
  return template.split('{frame}').join(encodeURIComponent(frame));
}

export function previewRasterSource(template: string, frame: string, maxNativeZoom: number): PreviewRasterSource {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    type: 'raster',
    tiles: [frameTileUrl(template, frame)],
    tileSize: PREVIEW_TILE_SIZE,
    minzoom: 0,
    maxzoom: maxNativeZoom,
    attribution: 'NOAA GFS · derived usable lift/precip · provisional'
  };
}

export function previewRasterLayer(opacity = DEFAULT_OPACITY): PreviewRasterLayer {
  return {
    id: OVERLAY_LAYER_ID,
    type: 'raster',
    source: OVERLAY_SOURCE_ID,
    paint: {
      'raster-opacity': clampOpacity(opacity),
      'raster-fade-duration': 0
    }
  };
}

export function windyTileOptions(maxNativeZoom: number, opacity = DEFAULT_OPACITY): WindyTileOptions {
  if (!Number.isInteger(maxNativeZoom) || maxNativeZoom < 0) throw new RangeError('maxNativeZoom must be a non-negative integer');
  return {
    tileSize: PREVIEW_TILE_SIZE,
    detectRetina: false,
    minZoom: 0,
    maxZoom: 18,
    maxNativeZoom,
    minNativeZoom: 0,
    opacity: clampOpacity(opacity),
    attribution: 'NOAA GFS · derived usable lift/precip · provisional'
  };
}

export function populateModelOptions(select: { add(option: unknown): void }): void {
  const OptionCtor = (globalThis as { Option?: new (text: string, value: string) => { disabled: boolean } }).Option;
  if (!OptionCtor) throw new Error('Global Option constructor is not available');
  for (const model of MODEL_IDS) {
    const regional = model !== 'gfs';
    const option = new OptionCtor(regional ? `${model} (unavailable: regional coverage not implemented)` : model, model);
    option.disabled = regional;
    select.add(option);
  }
}
