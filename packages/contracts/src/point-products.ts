/** Build-pinned batch samples and nearest-native-cell atmospheric profiles. */
import z from 'zod';
import type { SoaringViews } from '@av/soaring';
import { MAX_PROFILE_LEVELS, MAX_SAMPLE_VALUES } from './format.js';
import { frameSchema, modelIdSchema, sampleResponseV5Schema } from './publication.js';

export const MAX_SAMPLE_POINTS = 64;
export const MAX_POINT_RESPONSE_BYTES = 1024 * 1024;

const PROFILE_RESPONSE_HEADER_BYTES = 2048;

/** Conservative admission for one frame: quantized levels, scalar cells and frame metadata. */
function profileFrameBytes(levelCount: number, layerCount: number): number {
  if (![levelCount, layerCount].every(value => Number.isSafeInteger(value) && value > 0)) throw new RangeError('Invalid profile response dimensions');
  return levelCount * 180 + layerCount * 400 + PROFILE_RESPONSE_HEADER_BYTES;
}

/** Conservative JSON admission for quantized profile levels, scalar cells and frame metadata. */
export function estimateProfileResponseBytes(frameCount: number, levelCount: number, layerCount: number): number {
  if (!Number.isSafeInteger(frameCount) || frameCount < 1) throw new RangeError('Invalid profile response dimensions');
  const bytes = PROFILE_RESPONSE_HEADER_BYTES + frameCount * profileFrameBytes(levelCount, layerCount);
  if (!Number.isSafeInteger(bytes)) throw new RangeError('Profile response size overflow');
  return bytes;
}

/** Largest frame count one profile response may carry, derived from the same admission estimate. */
export function maxProfileFrames(levelCount: number, layerCount: number): number {
  return Math.floor((MAX_POINT_RESPONSE_BYTES - PROFILE_RESPONSE_HEADER_BYTES) / profileFrameBytes(levelCount, layerCount));
}
export const multiPointSampleResponseSchema = z.strictObject({
  version: z.literal(1), model: modelIdSchema, buildId: z.string(), expiresAt: z.iso.datetime(),
  points: z.array(z.strictObject({ index: z.number().int().nonnegative().max(MAX_SAMPLE_POINTS - 1), sample: sampleResponseV5Schema })).min(1).max(MAX_SAMPLE_POINTS)
}).superRefine((result, ctx) => {
  for (let i = 0; i < result.points.length; i++) {
    const point = result.points[i]!;
    if (point.index !== i || point.sample.model !== result.model || point.sample.buildId !== result.buildId || point.sample.expiresAt !== result.expiresAt) ctx.addIssue({ code: 'custom', message: 'Batch sample identity mismatch' });
  }
});

const scalar = z.number().finite().nullable(), regime = z.boolean().nullable();
export const soaringViewsSchema = z.strictObject({
  usableLiftTopV2M: scalar, hcritWxtoflyM: scalar, dryHcritM: scalar, cuPotentialM: scalar, odPotentialM: scalar,
  wind10mSpeedMps: scalar, wind10mDirDeg: scalar, 
  blMeanWindSpeedMps: scalar, blMeanWindDirDeg: scalar, blTopWindSpeedMps: scalar, blTopWindDirDeg: scalar,
  blWindShearMps: scalar, buoyancyShearRatio: scalar, cumulus: regime, overdeveloped: regime, cloudCapped: regime
} satisfies { [Key in keyof SoaringViews]: z.ZodType<SoaringViews[Key]> });

export const profileLevelSchema = z.strictObject({
  pressureHpa: z.number().finite().positive().nullable(), heightM: scalar, temperatureC: scalar,
  dewPointC: scalar, uWindMps: scalar, vWindMps: scalar, omegaPaS: scalar
});
const nativeProfileSchema = z.strictObject({
  modelTerrainM: scalar, surfacePressureHpa: z.number().finite().positive().nullable(), status: z.enum(['valid', 'unavailable', 'outside-domain']),
  levels: z.array(profileLevelSchema).max(MAX_PROFILE_LEVELS)
}).superRefine((profile, ctx) => {
  if (profile.status === 'valid' ? profile.modelTerrainM === null || !profile.levels.length
    : profile.status === 'unavailable' && profile.modelTerrainM !== null && profile.levels.length !== 0) ctx.addIssue({ code: 'custom', message: 'Profile status and values differ' });
  if (profile.status === 'outside-domain' && (profile.modelTerrainM !== null || profile.surfacePressureHpa !== null || profile.levels.length)) ctx.addIssue({ code: 'custom', message: 'Outside profile carries a surface state' });
  let previousHeight = -Infinity, previousPressure = Infinity;
  for (const level of profile.levels) {
    if ((level.heightM !== null && ((profile.modelTerrainM !== null && level.heightM < profile.modelTerrainM) || level.heightM <= previousHeight))
      || (level.pressureHpa !== null && level.pressureHpa >= previousPressure)) ctx.addIssue({ code: 'custom', message: 'Invalid profile coordinate order' });
    if (level.heightM !== null) previousHeight = level.heightM;
    if (level.pressureHpa !== null) previousPressure = level.pressureHpa;
  }
});
export const profileResponseSchema = z.strictObject({
  version: z.literal(1), model: modelIdSchema, buildId: z.string(), cycle: z.iso.datetime(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(),
  lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
  cell: z.strictObject({ index: z.number().int().nonnegative(), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180), surfaceId: modelIdSchema }).nullable(),
  method: sampleResponseV5Schema.shape.method, source: sampleResponseV5Schema.shape.source,
  frames: z.array(frameSchema.extend({ layers: sampleResponseV5Schema.shape.frames.element.shape.layers, profile: nativeProfileSchema, derived: soaringViewsSchema.extend({ mixedLayerLclM: scalar, effectiveCloudLimitM: scalar }) })).min(1).max(MAX_SAMPLE_VALUES)
});

export type MultiPointSampleResponse = z.infer<typeof multiPointSampleResponseSchema>;
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
