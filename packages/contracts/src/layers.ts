import z from 'zod';
import { LIFT_METHOD, PRECIPITATION_METHOD, methodIdSchema } from './methods.js';
import { LAYER_IDS, type LayerId } from './products.js';
import { CELL_BYTES } from './format.js';
import { getBit, type CoverageMask } from './coverage.js';

export const SAMPLE_STATUSES = ['valid', 'no-usable-lift', 'unavailable', 'outside-domain'] as const;
export const STATUS_VALID = 0, STATUS_NO_LIFT = 1, STATUS_UNAVAILABLE = 2, STATUS_OUTSIDE = 3, STATUS_MASK = 3;
export const SUPPORT_PARCEL_CROSSING = 4, SUPPORT_PROFILE_TOP = 8, SUPPORT_PBL_CLOSURE = 16, SUPPORT_MASK = 28;
export const layerIdSchema = z.enum(LAYER_IDS);
export const sampleStatusSchema = z.enum(SAMPLE_STATUSES);
export type SampleStatus = z.infer<typeof sampleStatusSchema>;

export const LIFT_EDGES = [0,300,600,900,1200,1500,1850,2150,2450,2750,3050,3350,3650,3950,4250,4550,4900,5200,5500,5800,6100,6400,6700] as const;
export const LIFT_COLORS = ['#55184d','#b93b88','#8f7fac','#62cbff','#0168ff','#00345d','#036d00','#35cd34','#9dff64','#fefa02','#cbc939','#d59b99','#d3595a','#f92d2d','#9b0900','#d87400','#ffa50b','#f1cd5d','#a6a7a9','#516565','#1c4f4f','#003333'] as const;
export const LIFT_RENDER_STYLE = 'transparent-no-lift-v2' as const;
export const RAIN_EDGES = [0.1,0.5,1,2,5,10,20,50] as const;
export const RAIN_COLORS = ['#b9e5ff','#66b3ff','#2d78d2','#36a657','#f0dc43','#f09b32','#dc493c','#963f9c'] as const;
export const PALETTES = { lift: { id: 'lift', edges: LIFT_EDGES, colors: LIFT_COLORS, units: 'm', noLiftColor: '#00000000' }, rain: { id: 'rain', edges: RAIN_EDGES, colors: RAIN_COLORS, units: 'mm/h', transparentBelow: 0.1, provisional: true } } as const;


export const PALETTE_IDS = Object.keys(PALETTES) as (keyof typeof PALETTES)[];
export const paletteIdSchema = z.enum(PALETTE_IDS);
export type PaletteId = z.infer<typeof paletteIdSchema>;

export const paletteSchema = z.object({ id: z.string().min(1), edges: z.array(z.number().finite()).min(1).max(256), colors: z.array(z.string().regex(/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/)).min(1).max(256), units: z.string(), noLiftColor: z.string().optional(), transparentBelow: z.number().finite().optional(), provisional: z.boolean().optional() });
export const layerDescriptorSchema = z.object({
  id: layerIdSchema, kind: z.literal('scalar'), label: z.string().min(1), quantity: z.string().min(1), units: z.string().min(1),
  verticalReference: z.enum(['MSL', 'model-AGL', 'surface']), timeSupport: z.enum(['interval-mean', 'interval-flux-endpoint-profile']),
  methodId: methodIdSchema, palette: paletteIdSchema, supportsNoLift: z.boolean(), supportsLiftFlags: z.boolean(),
  noLiftSampleValue: z.number().finite().nullable(), zeroOnNoLiftInterpolation: z.boolean(), hideNonPositiveValues: z.boolean()
});

export type LayerSpec = z.infer<typeof layerDescriptorSchema>;

export const LAYERS = {
  'usable-lift-msl': {
    id: 'usable-lift-msl',
    label: 'Usable lift top (MSL)', quantity: 'usable-lift-top', verticalReference: 'MSL',
    timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD.id,
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
    label: 'Usable lift depth (model AGL)', quantity: 'usable-lift-top', verticalReference: 'model-AGL',
    timeSupport: 'interval-flux-endpoint-profile', methodId: LIFT_METHOD.id,
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
    label: 'Precipitation rate', quantity: 'precipitation-rate', verticalReference: 'surface',
    timeSupport: 'interval-mean', methodId: PRECIPITATION_METHOD.id,
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

