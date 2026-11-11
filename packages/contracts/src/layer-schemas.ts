import z from 'zod';
import { LAYER_IDS, PALETTE_IDS, PALETTE_INTERPOLATIONS, SAMPLE_STATUSES } from './layers.js';
import { methodIdSchema } from './method-schemas.js';

export const layerIdSchema = z.enum(LAYER_IDS);
export const sampleStatusSchema = z.enum(SAMPLE_STATUSES);
export const paletteIdSchema = z.enum(PALETTE_IDS);


export const paletteSchema = z.object({ id: z.string().min(1), edges: z.array(z.number().finite()).min(1).max(256), colors: z.array(z.string().regex(/^#[a-fA-F0-9]{6}([a-fA-F0-9]{2})?$/)).min(1).max(256), units: z.string(), noLiftColor: z.string().optional(), transparentBelow: z.number().finite().optional(), provisional: z.boolean().optional(), interpolation: z.enum(PALETTE_INTERPOLATIONS).optional() });
export const layerDescriptorSchema = z.object({
  id: layerIdSchema, kind: z.literal('scalar'), label: z.string().min(1), quantity: z.string().min(1), units: z.string().min(1),
  verticalReference: z.enum(['MSL', 'model-AGL', 'terrain-AGL', 'surface', 'pressure-level']), timeSupport: z.enum(['valid-time', 'interval-mean', 'interval-maximum', 'interval-flux-endpoint-profile']),
  methodId: methodIdSchema, palette: paletteIdSchema.optional(), delivery: z.enum(['tiles-and-samples', 'samples-only']).optional(),
  supportsNoLift: z.boolean(), supportsLiftFlags: z.boolean(),
  noLiftSampleValue: z.number().finite().nullable(), zeroOnNoLiftInterpolation: z.boolean(), hideNonPositiveValues: z.boolean()
}).refine(layer => layer.delivery === 'samples-only' || layer.palette !== undefined, 'Rendered layers require a palette');

export type LayerSpec = z.infer<typeof layerDescriptorSchema>;
