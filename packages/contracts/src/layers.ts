import { CELL_BYTES } from './format.js';
import { getBit } from './bits.js';
import type { CoverageMask } from './coverage.js';
import type { LayerSpec } from './layer-schemas.js';
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
export const LIFT_STEP_RENDER_STYLE = 'transparent-no-lift-v2' as const;
export const LIFT_RENDER_STYLE = 'continuous-lift-rgb-v1' as const;
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
export const PALETTES = { lift: { id: 'lift', edges: LIFT_EDGES, colors: LIFT_COLORS, units: 'm', noLiftColor: '#00000000', interpolation: 'step' }, rain: { id: 'rain', edges: RAIN_EDGES, colors: RAIN_COLORS, units: 'mm/h', transparentBelow: 0.1, provisional: true } } as const;


export const PALETTE_IDS = Object.keys(PALETTES) as (keyof typeof PALETTES)[];
export type PaletteId = keyof typeof PALETTES;

export const LIFT_METHOD_ID = 'dry-lenschow-1p2-v2';
export const ALL_HOURS_PRECIP_METHOD_ID = 'trailing-precipitation-rate-v2';

/** Native point channels and their physical method groups. */
export const NATIVE_LAYERS = {
  'thermal-velocity': { label: 'Thermal velocity', quantity: 'thermal-velocity', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'soaring' },
  'thermal-top-msl': { label: 'Thermal top', quantity: 'thermal-top', units: 'm MSL', verticalReference: 'MSL', methodGroup: 'soaring' },
  'pbl-height-agl': { label: 'Boundary-layer height', quantity: 'boundary-layer-height', units: 'm AGL', verticalReference: 'model-AGL', methodGroup: 'soaring' },
  'sensible-heat-flux': { label: 'Sensible heat flux', quantity: 'upward-sensible-heat-flux', units: 'W/m2', verticalReference: 'surface', methodGroup: 'soaring' },
  'latent-heat-flux': { label: 'Latent heat flux', quantity: 'upward-latent-heat-flux', units: 'W/m2', verticalReference: 'surface', methodGroup: 'soaring' },
  'surface-lcl-msl': { label: 'Surface LCL', quantity: 'lifting-condensation-level', units: 'm MSL', verticalReference: 'MSL', methodGroup: 'cloud' },
  'cape-jkg': { label: 'CAPE', quantity: 'convective-available-potential-energy', units: 'J/kg', verticalReference: 'surface', methodGroup: 'surface' },
  'cloud-cover-total': { label: 'Total cloud cover', quantity: 'cloud-cover-total', units: '%', verticalReference: 'surface', methodGroup: 'surface' },
  'cloud-cover-low': { label: 'Low cloud cover', quantity: 'cloud-cover-low', units: '%', verticalReference: 'surface', methodGroup: 'surface' },
  'sfc-temp-c': { label: 'Surface temperature', quantity: 'air-temperature', units: 'degC', verticalReference: 'surface', methodGroup: 'surface' },
  'sfc-dewpoint-c': { label: 'Surface dewpoint', quantity: 'dew-point-temperature', units: 'degC', verticalReference: 'surface', methodGroup: 'surface' },
  'mslp-hpa': { label: 'Mean sea-level pressure', quantity: 'air-pressure', units: 'hPa', verticalReference: 'MSL', methodGroup: 'surface' },
  'wind-10m-u': { label: '10 m eastward wind', quantity: 'eastward-wind', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'wind' },
  'wind-10m-v': { label: '10 m northward wind', quantity: 'northward-wind', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'wind' },
  'wind-gust-10m': { label: '10 m wind gust', quantity: 'wind-gust', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'wind' },
  'bl-mean-wind-u': { label: 'Boundary-layer mean eastward wind', quantity: 'eastward-wind', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'wind' },
  'bl-mean-wind-v': { label: 'Boundary-layer mean northward wind', quantity: 'northward-wind', units: 'm/s', verticalReference: 'model-AGL', methodGroup: 'wind' },
} as const;

export type NativeLayerId = keyof typeof NATIVE_LAYERS;
export type NativeMethodGroup = (typeof NATIVE_LAYERS)[NativeLayerId]['methodGroup'];
export const NATIVE_LAYER_IDS = Object.keys(NATIVE_LAYERS) as NativeLayerId[];
export const nativeMethodId = (group: NativeMethodGroup, coordinate: 'isobaric' | 'model-levels' = 'isobaric') =>
  `native-${group}${coordinate === 'model-levels' ? '-model-levels' : ''}-v1`;

export function isNativeThermalLayer(id: string): boolean {
  return id === 'thermal-velocity' || id === 'thermal-top-msl';
}

export function nativeLayerTimeSupport(id: NativeLayerId): 'valid-time' | 'interval-mean' | 'interval-flux-endpoint-profile' {
  return id.endsWith('heat-flux') ? 'interval-mean' : isNativeThermalLayer(id) ? 'interval-flux-endpoint-profile' : 'valid-time';
}

const renderedLayerDefinitions = {
  'usable-lift-msl': { surface: 'fine', spec: {
      id: 'usable-lift-msl',
      label: 'Usable lift top (MSL)', quantity: 'usable-lift-top', verticalReference: 'MSL',
      timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD_ID,
      kind: 'scalar',
      units: 'm MSL',
      palette: 'lift',
      supportsNoLift: true,
      supportsLiftFlags: true,
      noLiftSampleValue: null,
      zeroOnNoLiftInterpolation: false,
      hideNonPositiveValues: false
  } },
  'usable-lift-agl': { surface: 'fine', spec: {
      id: 'usable-lift-agl',
      label: 'Usable lift depth (model AGL)', quantity: 'usable-lift-top', verticalReference: 'model-AGL',
      timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD_ID,
      kind: 'scalar',
      units: 'm AGL',
      palette: 'lift',
      supportsNoLift: true,
      supportsLiftFlags: true,
      noLiftSampleValue: 0,
      zeroOnNoLiftInterpolation: true,
      hideNonPositiveValues: true
  } },
  'precip-rate': { surface: 'native', spec: {
      id: 'precip-rate',
      label: 'Precipitation rate', quantity: 'precipitation-rate', verticalReference: 'surface',
      timeSupport: 'interval-mean', methodId: ALL_HOURS_PRECIP_METHOD_ID,
      kind: 'scalar',
      units: 'mm/h',
      palette: 'rain',
      supportsNoLift: false,
      supportsLiftFlags: false,
      noLiftSampleValue: null,
      zeroOnNoLiftInterpolation: false,
      hideNonPositiveValues: false
  } },
} as const;

type RenderedLayerId = keyof typeof renderedLayerDefinitions;
export type LayerId = RenderedLayerId | NativeLayerId;
const renderedLayerIds = Object.keys(renderedLayerDefinitions) as RenderedLayerId[];
export const LAYER_IDS: readonly LayerId[] = [...renderedLayerIds, ...NATIVE_LAYER_IDS];

export const LAYERS: Readonly<Record<LayerId, LayerSpec>> = {
  ...Object.fromEntries(renderedLayerIds.map(id => [id, renderedLayerDefinitions[id].spec satisfies LayerSpec])) as Record<RenderedLayerId, LayerSpec>,
  ...Object.fromEntries(NATIVE_LAYER_IDS.map(id => {
    const { label, quantity, units, verticalReference, methodGroup } = NATIVE_LAYERS[id];
    return [id, { id, label, quantity, units, verticalReference, kind: 'scalar',
      timeSupport: nativeLayerTimeSupport(id),
      methodId: nativeMethodId(methodGroup), delivery: 'samples-only', supportsNoLift: false,
      supportsLiftFlags: isNativeThermalLayer(id), noLiftSampleValue: null,
      zeroOnNoLiftInterpolation: false, hideNonPositiveValues: false } satisfies LayerSpec];
  })) as Record<NativeLayerId, LayerSpec>
};

export function isPaletteId(value: string): value is PaletteId {
  return Object.hasOwn(PALETTES, value);
}
export function isLayerId(value: string): value is LayerId {
  return Object.hasOwn(LAYERS, value);
}
export function layerSurface(layer: LayerId): 'native' | 'fine' {
  return Object.hasOwn(renderedLayerDefinitions, layer) ? renderedLayerDefinitions[layer as RenderedLayerId].surface : 'native';
}
export function renderedLayers(layers: readonly LayerId[], descriptors: Readonly<Record<string, Pick<LayerSpec, 'delivery'>>> = LAYERS): LayerId[] {
  return layers.filter(id => descriptors[id]?.delivery !== 'samples-only');
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

