import z from 'zod';

export const MODEL_IDS = ['gfs', 'hrrr', 'icon-armenia'] as const;
export const LAYER_IDS = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const;
export const PALETTE_IDS = ['lift', 'rain'] as const;
export const SAMPLE_STATUSES = ['valid', 'no-usable-lift', 'unavailable', 'outside-domain'] as const;
export const modelIdSchema = z.enum(MODEL_IDS);
export const layerIdSchema = z.enum(LAYER_IDS);
export const paletteIdSchema = z.enum(PALETTE_IDS);
export const sampleStatusSchema = z.enum(SAMPLE_STATUSES);
export type ModelId = z.infer<typeof modelIdSchema>;
export type LayerId = z.infer<typeof layerIdSchema>;
export type PaletteId = z.infer<typeof paletteIdSchema>;
export type SampleStatus = z.infer<typeof sampleStatusSchema>;
export const gridSchema = z.object({ width: z.number().int().positive(), height: z.number().int().positive(), lon0: z.number().finite(), lat0: z.number().finite(), dx: z.number().finite().refine(v => v !== 0), dy: z.number().finite().refine(v => v !== 0), wrapLongitude: z.boolean() });
export type Grid = z.infer<typeof gridSchema>;
export const GFS_GRID: Grid = { width: 1440, height: 721, lon0: -180, lat0: 90, dx: 0.25, dy: -0.25, wrapLongitude: true };
export const CELL_BYTES = 5;
export const SAMPLE_BLOCK_SIZE = 16;
export const MAX_SAMPLE_VALUES = 256;
export const MAX_SAMPLE_RANGE_BYTES = 256 * 1024;
export const RETENTION_DAYS = 7;
export const MAX_RETAINED_BUILDS = 256;
export const STATUS_VALID = 0, STATUS_NO_LIFT = 1, STATUS_UNAVAILABLE = 2, STATUS_OUTSIDE = 3, STATUS_MASK = 3;
export const SUPPORT_PARCEL_CROSSING = 4, SUPPORT_PROFILE_TOP = 8, SUPPORT_PBL_CLOSURE = 16, SUPPORT_MASK = 28;

export function normalizeLon(lon: number): number {
  if (!Number.isFinite(lon)) return lon;
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return wrapped === -180 && lon > 0 ? 180 : Object.is(wrapped, -0) ? 0 : wrapped;
}

export interface CoverageMask { grid: Grid; output: Uint8Array; halo: Uint8Array; tiles: Uint8Array; maxZoom: number }
export function getBit(bits: Uint8Array, index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < bits.length * 8 && (bits[index >> 3] & (1 << (index & 7))) !== 0;
}
export function setBit(bits: Uint8Array, index: number, value = true): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bits.length * 8) throw new RangeError('bit index out of bounds');
  const i = index >> 3, bit = 1 << (index & 7);
  bits[i] = value ? bits[i] | bit : bits[i] & ~bit;
}
/** Stable row-major index lists reused across acquisition, derivation and summaries. */
export function coverageIndices(mask: CoverageMask): { output: Uint32Array; active: Uint32Array } {
  const size = mask.grid.width * mask.grid.height, out: number[] = [], act: number[] = [];
  for (let i = 0; i < size; i++) {
    const isOut = getBit(mask.output, i);
    if (isOut) out.push(i);
    if (isOut || getBit(mask.halo, i)) act.push(i);
  }
  return { output: Uint32Array.from(out), active: Uint32Array.from(act) };
}
const snap = (n: number) => Math.abs(n - Math.round(n)) <= 1e-10 ? Math.round(n) : n;
export function isCovered(mask: CoverageMask, lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -55 || lat > 65 || lon < -180 || lon > 180) return false;
  const { grid } = mask;
  let x = snap((lon - grid.lon0) / grid.dx);
  const y = snap((lat - grid.lat0) / grid.dy);
  if (grid.wrapLongitude) x = snap(((x % grid.width) + grid.width) % grid.width);
  if ((!grid.wrapLongitude && (x < -0.5 || x > grid.width - 0.5)) || y < -0.5 || y > grid.height - 0.5) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c0 = grid.wrapLongitude ? ((x0 % grid.width) + grid.width) % grid.width : x0;
  const c1 = grid.wrapLongitude ? (((x0 + 1) % grid.width) + grid.width) % grid.width : x0 + 1;
  const col = fx === 0 ? c0 : fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
  const row = fy <= 0.5 ? Math.max(0, y0) : Math.min(grid.height - 1, y0 + 1);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return getBit(mask.output, row * grid.width + col);
}
export function isTileCovered(mask: CoverageMask, z: number, x: number, y: number): boolean {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24 || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= 2 ** z || y >= 2 ** z) return false;
  return getBit(mask.tiles, (4 ** z - 1) / 3 + y * 2 ** z + x);
}
export function expectedTiles(mask: CoverageMask, z: number): { z: number; x: number; y: number }[] {
  if (!Number.isInteger(z) || z < 0 || z > mask.maxZoom || z > 24) return [];
  const span = 2 ** z, total = span * span, result: { z: number; x: number; y: number }[] = [];
  for (let i = 0; i < total; i++) {
    const x = i % span, y = (i - x) / span;
    if (isTileCovered(mask, z, x, y)) result.push({ z, x, y });
  }
  return result;
}

export const LIFT_EDGES = [0,300,600,900,1200,1500,1850,2150,2450,2750,3050,3350,3650,3950,4250,4550,4900,5200,5500,5800,6100,6400,6700] as const;
export const LIFT_COLORS = ['#55184d','#b93b88','#8f7fac','#62cbff','#0168ff','#00345d','#036d00','#35cd34','#9dff64','#fefa02','#cbc939','#d59b99','#d3595a','#f92d2d','#9b0900','#d87400','#ffa50b','#f1cd5d','#a6a7a9','#516565','#1c4f4f','#003333'] as const;
export const LIFT_RENDER_STYLE = 'transparent-no-lift-v2' as const;
export const RAIN_EDGES = [0.1,0.5,1,2,5,10,20,50] as const;
export const RAIN_COLORS = ['#b9e5ff','#66b3ff','#2d78d2','#36a657','#f0dc43','#f09b32','#dc493c','#963f9c'] as const;
export const PALETTES = { lift: { id: 'lift', edges: LIFT_EDGES, colors: LIFT_COLORS, units: 'm', noLiftColor: '#00000000' }, rain: { id: 'rain', edges: RAIN_EDGES, colors: RAIN_COLORS, units: 'mm/h', transparentBelow: 0.1, provisional: true } } as const;

export interface LayerSpec {
  readonly id: LayerId;
  readonly kind: 'scalar';
  readonly units: string;
  readonly palette: PaletteId;
  readonly supportsNoLift: boolean;
  readonly supportsLiftFlags: boolean;
  readonly noLiftSampleValue: number | null;
  readonly zeroOnNoLiftInterpolation: boolean;
  readonly hideNonPositiveValues: boolean;
}

export const LAYERS = {
  'usable-lift-msl': {
    id: 'usable-lift-msl',
    kind: 'scalar',
    units: 'm MSL',
    palette: 'lift',
    supportsNoLift: true,
    supportsLiftFlags: true,
    noLiftSampleValue: null,
    zeroOnNoLiftInterpolation: false,
    hideNonPositiveValues: false
  },
  'usable-lift-agl': {
    id: 'usable-lift-agl',
    kind: 'scalar',
    units: 'm AGL',
    palette: 'lift',
    supportsNoLift: true,
    supportsLiftFlags: true,
    noLiftSampleValue: 0,
    zeroOnNoLiftInterpolation: true,
    hideNonPositiveValues: true
  },
  'precip-rate': {
    id: 'precip-rate',
    kind: 'scalar',
    units: 'mm/h',
    palette: 'rain',
    supportsNoLift: false,
    supportsLiftFlags: false,
    noLiftSampleValue: null,
    zeroOnNoLiftInterpolation: false,
    hideNonPositiveValues: false
  }
} as const satisfies Record<LayerId, LayerSpec>;

/** Trusted product admission. New providers must declare their native product here. */
export interface ProductDefinition {
  readonly grid: Grid;
  readonly coverageId: string;
  readonly maxNativeZoom: number;
  readonly frameHours: readonly number[];
  readonly intervalHours: number;
  readonly layers: readonly LayerId[];
}
export const GFS_PRODUCT: ProductDefinition = {
  grid: GFS_GRID, coverageId: 'soaring-land-v1', maxNativeZoom: 7,
  frameHours: [3, 6, 9, 12, 15, 18, 21, 24], intervalHours: 3, layers: LAYER_IDS
};
const products: Partial<Record<ModelId, ProductDefinition>> = { gfs: GFS_PRODUCT };
export function getProduct(model: ModelId): ProductDefinition | undefined { return products[model]; }

export function isPaletteId(value: string): value is PaletteId {
  return Object.hasOwn(PALETTES, value);
}
export function isLayerId(value: string): value is LayerId {
  return Object.hasOwn(LAYERS, value);
}
export function paletteBinLabel(edges: readonly number[], colorCount: number, index: number): string {
  const from = edges[index], to = edges[index + 1];
  if (to === undefined) return `≥ ${from}`;
  return index === colorCount - 1 ? `${from}–${to}+` : `${from}–${to}`;
}
export function paletteBinIndex(layer: LayerId, value: number | null, status: number, colorCount?: number): number {
  const code = status & STATUS_MASK;
  if (code >= STATUS_UNAVAILABLE) return -1;
  const spec = LAYERS[layer];
  if ((spec.supportsNoLift && code === STATUS_NO_LIFT) || value === null || !Number.isFinite(value) || (spec.hideNonPositiveValues && value <= 0)) return -1;
  const palette = PALETTES[spec.palette];
  if ('transparentBelow' in palette && value < palette.transparentBelow) return -1;
  const maxBin = Math.min(colorCount ?? palette.colors.length, palette.edges.length) - 1;
  for (let i = maxBin; i > 0; i--) if (value >= palette.edges[i]) return i;
  return 0;
}
export function paletteColor(layer: LayerId, value: number | null, status: number): string | null {
  const palette = PALETTES[LAYERS[layer].palette];
  const bin = paletteBinIndex(layer, value, status, palette.colors.length);
  return bin < 0 ? null : palette.colors[bin];
}

const timestamp = z.iso.datetime();
const key = z.string().min(1);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const frameSchema = z.object({ id: key, validTime: timestamp, intervalStart: timestamp, intervalEnd: timestamp });
export const artifactSchema = z.object({ layer: layerIdSchema, frame: key, tilesKey: key, tilesSha256: sha256 });
/** Channels follow frames, then layers, in manifest order; the coverage determines block offsets. */
export const samplePackSchema = z.object({ format: z.literal('cell-major-blocks-v1'), blockSize: z.literal(SAMPLE_BLOCK_SIZE), storedCells: z.number().int().positive(), channelCount: z.number().int().positive(), bytes: z.number().int().positive(), key, sha256 });
export const manifestSchema = z.object({ version: z.literal(2), model: modelIdSchema, buildId: key, cycle: timestamp, createdAt: timestamp, expiresAt: timestamp, method: z.object({ id: key, hash: sha256 }), coverage: z.object({ id: key, hash: sha256, maskKey: key, maxZoom: z.number().int().nonnegative() }), grid: gridSchema, frames: z.array(frameSchema).min(1), layers: z.array(layerIdSchema).min(1), artifacts: z.array(artifactSchema).min(1), samples: samplePackSchema, source: z.record(z.string(), z.unknown()), tool: z.record(z.string(), z.unknown()), palettes: z.array(key).min(1), metrics: z.record(z.string(), z.unknown()) });
export const provenanceSchema = z.object({ version: z.literal(1), model: modelIdSchema, buildId: key, cycle: timestamp, frames: z.array(z.unknown()) }).passthrough();
export const retainedBuildSchema = z.object({ buildId: key, manifestKey: key, cycle: timestamp, expiresAt: timestamp });
export const modelPointerSchema = z.object({ version: z.literal(1), model: modelIdSchema, latestBuildId: key, retained: z.array(retainedBuildSchema).min(1).max(MAX_RETAINED_BUILDS) }).refine(p => p.retained.some(b => b.buildId === p.latestBuildId), { message: 'latest build must be retained' });
export const sampleValueSchema = z.object({ value: z.number().finite().nullable(), status: sampleStatusSchema, support: z.number().int(), interpolated: z.boolean() });
export const sampleResponseSchema = z.object({ model: z.string(), buildId: z.string(), lat: z.number().finite(), lon: z.number().finite(), method: manifestSchema.shape.method, source: manifestSchema.shape.source, coverage: manifestSchema.shape.coverage, expiresAt: z.string(), frames: z.array(frameSchema.extend({ layers: z.record(z.string(), sampleValueSchema) })) });
export const paletteSchema = z.object({ id: z.string(), edges: z.array(z.number()), colors: z.array(z.string()), units: z.string(), noLiftColor: z.string().optional(), transparentBelow: z.number().optional(), provisional: z.boolean().optional() }).passthrough();
export const freshnessSchema = z.object({
  ageSeconds: z.number(),
  expiresAt: z.string(),
  cycle: z.string().optional(),
  cycleAgeSeconds: z.number().optional(),
  earliestValidTime: z.string().optional(),
  latestValidTime: z.string().optional(),
  horizonRemainingSeconds: z.number().optional(),
  horizonExhausted: z.boolean().optional()
});
export const latestSchema = z.object({ pointer: modelPointerSchema, manifest: manifestSchema.optional(), templates: z.record(z.string(), z.string()).optional(), bounds: z.array(z.number()).optional(), maxNativeZoom: z.number().optional(), palettes: z.array(paletteSchema).optional(), coverage: manifestSchema.shape.coverage.extend({ tileBits: z.array(z.number()).optional() }).optional(), freshness: freshnessSchema });
export type Manifest = z.infer<typeof manifestSchema>;
export type ModelPointer = z.infer<typeof modelPointerSchema>;
export type FreshnessSummary = z.infer<typeof freshnessSchema>;

/** The immutable forecast payloads; manifest and provenance are published separately. */
export function forecastObjects(manifest: Manifest): { key: string; sha256: string; contentType: string }[] {
  return [
    { key: manifest.samples.key, sha256: manifest.samples.sha256, contentType: 'application/octet-stream' },
    ...manifest.artifacts.map(a => ({ key: a.tilesKey, sha256: a.tilesSha256, contentType: 'application/vnd.pmtiles' }))
  ];
}

/** A sidecar belongs to one build; absent legacy references are allowed, incomplete ones are not. */
export function getProvenanceReference(
  manifest: Pick<Manifest, 'model' | 'buildId' | 'source'>
): { key: string; sha256: string } | null {
  const source = manifest.source;
  if (!Object.hasOwn(source, 'provenanceKey') && !Object.hasOwn(source, 'provenanceSha256')) return null;
  const digest = sha256.safeParse(source.provenanceSha256);
  if (source.provenanceKey !== `builds/${manifest.model}/${manifest.buildId}/provenance.json` || !digest.success) {
    throw new Error('Invalid provenance reference');
  }
  return { key: source.provenanceKey, sha256: digest.data };
}

export function parseProvenance(
  raw: unknown,
  manifest: Pick<Manifest, 'model' | 'buildId' | 'cycle'>
): z.infer<typeof provenanceSchema> {
  const provenance = provenanceSchema.parse(raw);
  if (provenance.model !== manifest.model || provenance.buildId !== manifest.buildId || provenance.cycle !== manifest.cycle) {
    throw new Error('Provenance does not match manifest');
  }
  return provenance;
}

export function compactSource(source: Record<string, unknown>): Record<string, unknown> {
  if (!('frames' in source) || !Array.isArray(source.frames)) return source;
  const { frames, ...rest } = source;
  return { ...rest, frameCount: typeof rest.frameCount === 'number' ? rest.frameCount : frames.length };
}

export function computeFreshness(
  manifest: Pick<Manifest, 'createdAt' | 'cycle' | 'expiresAt' | 'frames'>,
  nowMs = Date.now()
): Required<FreshnessSummary> {
  const validTimes = manifest.frames.map(f => Date.parse(f.validTime)).filter(Number.isFinite);
  const earliestMs = validTimes.length > 0 ? Math.min(...validTimes) : Date.parse(manifest.cycle);
  const latestMs = validTimes.length > 0 ? Math.max(...validTimes) : Date.parse(manifest.cycle);
  return {
    ageSeconds: Math.max(0, Math.floor((nowMs - Date.parse(manifest.createdAt)) / 1000)),
    expiresAt: manifest.expiresAt,
    cycle: manifest.cycle,
    cycleAgeSeconds: Math.max(0, Math.floor((nowMs - Date.parse(manifest.cycle)) / 1000)),
    earliestValidTime: new Date(earliestMs).toISOString(),
    latestValidTime: new Date(latestMs).toISOString(),
    horizonRemainingSeconds: Math.max(0, Math.floor((latestMs - nowMs) / 1000)),
    horizonExhausted: latestMs <= nowMs
  };
}

export function validateArtifactRecords(manifest: Manifest): void {
  const frames = new Set(manifest.frames.map(frame => frame.id));
  const layers = new Set(manifest.layers);
  if (frames.size === 0 || frames.size !== manifest.frames.length) throw new Error(`expected distinct frames, found ${manifest.frames.length}`);
  if (layers.size === 0 || layers.size !== manifest.layers.length) throw new Error(`expected distinct layers, found ${manifest.layers.length}`);
  const expectedRecords = frames.size * layers.size;
  if (manifest.artifacts.length !== expectedRecords) {
    throw new Error(`expected ${expectedRecords} artifact records, found ${manifest.artifacts.length}`);
  }
  const combinations = new Set<string>();
  const prefix = `builds/${manifest.model}/${manifest.buildId}`;
  if (manifest.samples.key !== `${prefix}/samples.bin` || manifest.samples.channelCount !== expectedRecords || !Number.isSafeInteger(manifest.samples.bytes) || manifest.samples.bytes !== manifest.samples.storedCells * expectedRecords * CELL_BYTES) {
    throw new Error('Invalid sample pack metadata');
  }
  for (const artifact of manifest.artifacts) {
    if (!frames.has(artifact.frame)) throw new Error(`unknown artifact frame ${artifact.frame}`);
    if (!layers.has(artifact.layer)) throw new Error(`unknown artifact layer ${artifact.layer}`);
    const combination = `${artifact.layer}/${artifact.frame}`;
    if (combinations.has(combination)) throw new Error(`duplicate artifact record ${combination}`);
    combinations.add(combination);
    if (artifact.tilesKey !== `${prefix}/${artifact.layer}/${artifact.frame}.pmtiles`) throw new Error(`unexpected tilesKey ${artifact.tilesKey}`);
  }
}

export function validateSampleFlags(bytes: Uint8Array, expectedLength: number, layer?: string, mask?: CoverageMask, key = 'samples'): void {
  if (bytes.length !== expectedLength) throw new Error(`samples length ${bytes.length}, expected ${expectedLength}`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const spec = layer !== undefined && isLayerId(layer) ? LAYERS[layer] : null;
  for (let offset = 0; offset < bytes.length; offset += CELL_BYTES) {
    const index = offset / CELL_BYTES;
    validateSampleCell(view, offset, spec, key, mask ? getBit(mask.output, index) || getBit(mask.halo, index) : undefined);
  }
}

/** Validate one wire record; flat and block storage share the same value/flag rules. */
export function validateSampleCell(view: DataView, offset: number, spec: LayerSpec | null, key: string, active?: boolean): void {
  const flags = view.getUint8(offset + 4), status = flags & STATUS_MASK;
  if ((flags & ~(STATUS_MASK | SUPPORT_MASK)) !== 0) throw new Error(`invalid support bits at offset ${offset} in ${key}`);
  if (spec && ((!spec.supportsNoLift && status === STATUS_NO_LIFT) || (!spec.supportsLiftFlags && (flags & SUPPORT_MASK) !== 0))) throw new Error(`invalid ${spec.id} lift flags at offset ${offset} in ${key}`);
  if (status === STATUS_OUTSIDE && flags !== STATUS_OUTSIDE) throw new Error(`invalid outside-domain support bits at offset ${offset} in ${key}`);
  if (status < STATUS_UNAVAILABLE && !Number.isFinite(view.getFloat32(offset, true))) throw new Error(`non-finite sample value at offset ${offset} in ${key}`);
  if (active !== undefined && (status === STATUS_OUTSIDE) === active) throw new Error(`Sample coverage mismatch in ${key}`);
}
