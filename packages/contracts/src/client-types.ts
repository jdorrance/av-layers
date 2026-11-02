import type { z } from 'zod';
import type { latestSchema, paletteSchema, sampleResponseSchema, LayerId, Manifest } from './index.ts';

export type PaletteSummary = z.infer<typeof paletteSchema>;
export type SamplePayload = z.infer<typeof sampleResponseSchema>;
export type FrameSample = SamplePayload['frames'][number];
export type FrameSampleLayer = FrameSample['layers'][string];

export interface PinnedBuild {
  manifest: Manifest;
  templates: Record<LayerId, string>;
  expiresAtMs: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type LatestPayload = z.infer<typeof latestSchema>;
