import { CELL_BYTES } from './format.js';
import { getBit } from './bits.js';
import type { CoverageMask } from './coverage.js';
import type { LayerProperties, LayerSpec } from './layer-schemas.js';
export type { LayerSpec } from './layer-schemas.js';

export const SAMPLE_STATUSES = ['valid', 'no-usable-lift', 'unavailable', 'outside-domain'] as const;
export const STATUS_VALID = 0, STATUS_NO_LIFT = 1, STATUS_UNAVAILABLE = 2, STATUS_OUTSIDE = 3, STATUS_MASK = 3;
export const SUPPORT_PARCEL_CROSSING = 4, SUPPORT_PROFILE_TOP = 8, SUPPORT_PBL_CLOSURE = 16;
export const SUPPORT_CUMULUS = 32, SUPPORT_OVERDEVELOPED = 64, SUPPORT_CLOUD_CAPPED = 128;
export const CLOUD_SUPPORT_MASK = SUPPORT_CUMULUS | SUPPORT_OVERDEVELOPED | SUPPORT_CLOUD_CAPPED;
export const SUPPORT_MASK = SUPPORT_PARCEL_CROSSING | SUPPORT_PROFILE_TOP | SUPPORT_PBL_CLOSURE | CLOUD_SUPPORT_MASK;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export const LIFT_EDGES = [0,300,600,900,1200,1500,1850,2150,2450,2750,3050,3350,3650,3950,4250,4550,4900,5200,5500,5800,6100,6400,6700] as const;
export const LIFT_COLORS = ['#55184d','#b93b88','#8f7fac','#62cbff','#0168ff','#00345d','#036d00','#35cd34','#9dff64','#fefa02','#cbc939','#d59b99','#d3595a','#f92d2d','#9b0900','#d87400','#ffa50b','#f1cd5d','#a6a7a9','#516565','#1c4f4f','#003333'] as const;
export const LIFT_STEP_RENDER_STYLE = 'terrain-msl-step-v1' as const;
export const LIFT_RENDER_STYLE = 'terrain-msl-linear-rgb-v1' as const;
export const RAIN_EDGES = [0.1,0.5,1,2,5,10,20,50] as const;
export const RAIN_COLORS = ['#b9e5ff','#66b3ff','#2d78d2','#36a657','#f0dc43','#f09b32','#dc493c','#963f9c'] as const;
export const PALETTE_INTERPOLATIONS = ['step', 'linear-rgb'] as const;
export type PaletteInterpolation = typeof PALETTE_INTERPOLATIONS[number];
export function paletteInterpolation(palette: object | null | undefined): PaletteInterpolation {
  return palette != null && 'interpolation' in palette && palette.interpolation === 'linear-rgb' ? 'linear-rgb' : 'step';
}
export function liftRenderStyle(interpolation: PaletteInterpolation | undefined): typeof LIFT_RENDER_STYLE | typeof LIFT_STEP_RENDER_STYLE {
  return interpolation === 'linear-rgb' ? LIFT_RENDER_STYLE : LIFT_STEP_RENDER_STYLE;
}
export const CLOUD_EDGES = [10, 25, 50, 75, 90] as const;
export const CLOUD_COLORS = ['#dce6f2', '#b8cce4', '#8eaadb', '#5b84c4', '#2f5597'] as const;
export const PALETTE_IDS = ['lift', 'rain', 'cloud'] as const;
export type PaletteId = (typeof PALETTE_IDS)[number];
const PALETTE_ID_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(PALETTE_IDS);
export const PALETTES = {
  lift: { id: 'lift', edges: LIFT_EDGES, colors: LIFT_COLORS, units: 'm', noLiftColor: '#00000000', interpolation: 'step' },
  rain: { id: 'rain', edges: RAIN_EDGES, colors: RAIN_COLORS, units: 'mm/h', transparentBelow: 0.1, provisional: true },
  cloud: { id: 'cloud', edges: CLOUD_EDGES, colors: CLOUD_COLORS, units: '%', transparentBelow: 10, provisional: true }
} as const satisfies Record<PaletteId, { id: string; edges: readonly number[]; colors: readonly string[]; units: string } & Record<string, unknown>>;

export const LIFT_METHOD_ID = 'dry-lenschow-1p2-v2';
export const ALL_HOURS_PRECIP_METHOD_ID = 'trailing-precipitation-rate-v2';

export type NativeMethodGroup = 'soaring' | 'cloud' | 'surface' | 'wind';
export const nativeMethodId = (group: NativeMethodGroup, coordinate: 'isobaric' | 'model-levels' = 'isobaric') =>
  `native-${group}${coordinate === 'model-levels' ? '-model-levels' : ''}-v1`;

type NativeSpecInput = Pick<LayerProperties, 'label' | 'quantity' | 'units' | 'verticalReference'> & Partial<Pick<LayerProperties, 'timeSupport' | 'supportsLiftFlags'>>;
function nativeLayer<const P extends PaletteId>(methodGroup: NativeMethodGroup, spec: NativeSpecInput & { palette: P }): { surface: 'native'; methodGroup: NativeMethodGroup; spec: LayerProperties & { palette: P } };
function nativeLayer(methodGroup: NativeMethodGroup, spec: NativeSpecInput): { surface: 'native'; methodGroup: NativeMethodGroup; spec: LayerProperties & { delivery: 'samples-only' } };
function nativeLayer(methodGroup: NativeMethodGroup, spec: NativeSpecInput & { palette?: PaletteId }): { surface: 'native'; methodGroup: NativeMethodGroup; spec: LayerProperties } {
  const { label, quantity, units, verticalReference, timeSupport = 'valid-time', supportsLiftFlags = false, palette } = spec;
  const base = { label, quantity, units, verticalReference, kind: 'scalar' as const, timeSupport, methodId: nativeMethodId(methodGroup), supportsNoLift: false, supportsLiftFlags, noLiftSampleValue: null, zeroOnNoLiftInterpolation: false, hideNonPositiveValues: false };
  return { surface: 'native', methodGroup, spec: palette ? { ...base, palette } : { ...base, delivery: 'samples-only' } };
}

export const LAYER_IDS = [
  'usable-lift-msl', 'usable-lift-agl', 'precip-rate',
  'thermal-velocity', 'thermal-top-msl', 'pbl-height-agl', 'sensible-heat-flux', 'latent-heat-flux',
  'surface-lcl-msl', 'cape-jkg', 'cloud-cover-total', 'cloud-cover-low', 'sfc-temp-c', 'sfc-dewpoint-c', 'mslp-hpa',
  'wind-10m-u', 'wind-10m-v', 'wind-gust-10m', 'bl-mean-wind-u', 'bl-mean-wind-v'
] as const;
export type LayerId = (typeof LAYER_IDS)[number];
const LAYER_ID_SET: ReadonlySet<string> = /* @__PURE__ */ new Set(LAYER_IDS);

/** Publication channel order, descriptors and default storage surfaces. */
const LAYER_REGISTRY = /* @__PURE__ */ (() => ({
  'usable-lift-msl': { surface: 'fine', spec: {
    label: 'Usable lift top (MSL)', quantity: 'usable-lift-top', verticalReference: 'MSL',
    timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD_ID, kind: 'scalar', units: 'm MSL', palette: 'lift',
    supportsNoLift: true, supportsLiftFlags: true, noLiftSampleValue: null, zeroOnNoLiftInterpolation: false, hideNonPositiveValues: false
  } },
  'usable-lift-agl': { surface: 'fine', spec: {
    label: 'Usable lift depth (model AGL)', quantity: 'usable-lift-top', verticalReference: 'model-AGL',
    timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD_ID, kind: 'scalar', units: 'm AGL', palette: 'lift',
    supportsNoLift: true, supportsLiftFlags: true, noLiftSampleValue: 0, zeroOnNoLiftInterpolation: true, hideNonPositiveValues: true
  } },
  'precip-rate': { surface: 'native', spec: {
    label: 'Precipitation rate', quantity: 'precipitation-rate', verticalReference: 'surface',
    timeSupport: 'interval-mean', methodId: ALL_HOURS_PRECIP_METHOD_ID, kind: 'scalar', units: 'mm/h', palette: 'rain',
    supportsNoLift: false, supportsLiftFlags: false, noLiftSampleValue: null, zeroOnNoLiftInterpolation: false, hideNonPositiveValues: false
  } },
  'thermal-velocity': nativeLayer('soaring', {
    label: 'Thermal velocity', quantity: 'thermal-velocity', units: 'm/s', verticalReference: 'model-AGL',
    timeSupport: 'interval-flux-endpoint-profile', supportsLiftFlags: true
  }),
  'thermal-top-msl': nativeLayer('soaring', {
    label: 'Thermal top', quantity: 'thermal-top', units: 'm MSL', verticalReference: 'MSL',
    timeSupport: 'interval-flux-endpoint-profile', supportsLiftFlags: true
  }),
  'pbl-height-agl': nativeLayer('soaring', { label: 'Boundary-layer height', quantity: 'boundary-layer-height', units: 'm AGL', verticalReference: 'model-AGL' }),
  'sensible-heat-flux': nativeLayer('soaring', {
    label: 'Sensible heat flux', quantity: 'upward-sensible-heat-flux', units: 'W/m2', verticalReference: 'surface', timeSupport: 'interval-mean'
  }),
  'latent-heat-flux': nativeLayer('soaring', {
    label: 'Latent heat flux', quantity: 'upward-latent-heat-flux', units: 'W/m2', verticalReference: 'surface', timeSupport: 'interval-mean'
  }),
  'surface-lcl-msl': nativeLayer('cloud', { label: 'Surface LCL', quantity: 'lifting-condensation-level', units: 'm MSL', verticalReference: 'MSL' }),
  'cape-jkg': nativeLayer('surface', { label: 'CAPE', quantity: 'convective-available-potential-energy', units: 'J/kg', verticalReference: 'surface' }),
  'cloud-cover-total': nativeLayer('surface', { label: 'Total cloud cover', quantity: 'cloud-cover-total', units: '%', verticalReference: 'surface' }),
  'cloud-cover-low': nativeLayer('surface', { label: 'Low cloud cover', quantity: 'cloud-cover-low', units: '%', verticalReference: 'surface' }),
  'sfc-temp-c': nativeLayer('surface', { label: 'Surface temperature', quantity: 'air-temperature', units: 'degC', verticalReference: 'surface' }),
  'sfc-dewpoint-c': nativeLayer('surface', { label: 'Surface dewpoint', quantity: 'dew-point-temperature', units: 'degC', verticalReference: 'surface' }),
  'mslp-hpa': nativeLayer('surface', { label: 'Mean sea-level pressure', quantity: 'air-pressure', units: 'hPa', verticalReference: 'MSL' }),
  'wind-10m-u': nativeLayer('wind', { label: '10 m eastward wind', quantity: 'eastward-wind', units: 'm/s', verticalReference: 'model-AGL' }),
  'wind-10m-v': nativeLayer('wind', { label: '10 m northward wind', quantity: 'northward-wind', units: 'm/s', verticalReference: 'model-AGL' }),
  'wind-gust-10m': nativeLayer('wind', { label: '10 m wind gust', quantity: 'wind-gust', units: 'm/s', verticalReference: 'model-AGL' }),
  'bl-mean-wind-u': nativeLayer('wind', { label: 'Boundary-layer mean eastward wind', quantity: 'eastward-wind', units: 'm/s', verticalReference: 'model-AGL' }),
  'bl-mean-wind-v': nativeLayer('wind', { label: 'Boundary-layer mean northward wind', quantity: 'northward-wind', units: 'm/s', verticalReference: 'model-AGL' }),
} as const satisfies Record<LayerId, { surface: 'native' | 'fine'; spec: LayerProperties; methodGroup?: NativeMethodGroup }>))();

type FineLayerId = { [K in LayerId]: (typeof LAYER_REGISTRY)[K]['surface'] extends 'fine' ? K : never }[LayerId];
type DefaultRenderedLayerId = { [K in LayerId]: (typeof LAYER_REGISTRY)[K]['spec'] extends { delivery: 'samples-only' } ? never : K }[LayerId];
const FINE_LAYERS = ['usable-lift-msl', 'usable-lift-agl'] as const satisfies readonly FineLayerId[];
const DEFAULT_RENDERED_LAYERS = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const satisfies readonly DefaultRenderedLayerId[];
const FINE_LAYER_SET: ReadonlySet<LayerId> = /* @__PURE__ */ new Set<FineLayerId>(FINE_LAYERS satisfies Exclude<FineLayerId, (typeof FINE_LAYERS)[number]> extends never ? readonly FineLayerId[] : never);
const DEFAULT_RENDERED_SET: ReadonlySet<LayerId> = /* @__PURE__ */ new Set<DefaultRenderedLayerId>(DEFAULT_RENDERED_LAYERS satisfies Exclude<DefaultRenderedLayerId, (typeof DEFAULT_RENDERED_LAYERS)[number]> extends never ? readonly DefaultRenderedLayerId[] : never);

export const LAYERS: Readonly<Record<LayerId, LayerSpec>> =
  /* @__PURE__ */ (() => Object.fromEntries(LAYER_IDS.map(id => [id, { id, ...LAYER_REGISTRY[id].spec }])) as Record<LayerId, LayerSpec>)();

export function nativeLayerMethodGroup(id: string): NativeMethodGroup | undefined {
  const entry = isLayerId(id) ? LAYER_REGISTRY[id] : undefined;
  return entry && 'methodGroup' in entry ? entry.methodGroup : undefined;
}

export function isNativeThermalLayer(id: string): boolean {
  const entry = isLayerId(id) ? LAYER_REGISTRY[id] : undefined;
  return entry?.surface === 'native' && entry.spec.supportsLiftFlags;
}

export function isPaletteId(value: string): value is PaletteId {
  return PALETTE_ID_SET.has(value);
}
export function isLayerId(value: string): value is LayerId {
  return LAYER_ID_SET.has(value);
}
export function layerSurface(layer: LayerId): 'native' | 'fine' {
  return FINE_LAYER_SET.has(layer) ? 'fine' : 'native';
}
export function renderedLayers(layers: readonly LayerId[], descriptors?: Readonly<Record<string, Pick<LayerSpec, 'delivery'>>>): LayerId[] {
  return layers.filter(id => descriptors ? descriptors[id]?.delivery !== 'samples-only' : DEFAULT_RENDERED_SET.has(id));
}
export function layerPalette(layer: LayerId): PaletteId {
  const palette = LAYERS[layer].palette;
  if (!palette || LAYERS[layer].delivery === 'samples-only') throw new RangeError(`Layer ${layer} has no raster palette`);
  return palette;
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
  const palette = PALETTES[layerPalette(layer)];
  if ('transparentBelow' in palette && value < palette.transparentBelow) return -1;
  const maxBin = Math.min(colorCount ?? palette.colors.length, palette.edges.length) - 1;
  for (let i = maxBin; i > 0; i--) if (value >= palette.edges[i]) return i;
  return 0;
}
export function paletteColor(layer: LayerId, value: number | null, status: number): string | null {
  const palette = PALETTES[layerPalette(layer)];
  const bin = paletteBinIndex(layer, value, status, palette.colors.length);
  return bin < 0 ? null : palette.colors[bin];
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

