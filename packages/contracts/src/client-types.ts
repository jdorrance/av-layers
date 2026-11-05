import type { z } from 'zod';
import type { latestSchema, paletteSchema, publishedSampleResponseSchema, LayerId, PublishedManifest } from './index.ts';

export type PaletteSummary = z.infer<typeof paletteSchema>;
export type SamplePayload = z.infer<typeof publishedSampleResponseSchema>;
export type FrameSample = SamplePayload['frames'][number];
export type FrameSampleLayer = FrameSample['layers'][string];

export interface PinnedBuild {
  manifest: PublishedManifest;
  templates: Partial<Record<LayerId, string>>;
  expiresAtMs: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type PointHorizon = 'day' | 'forecast';

/** A bounded cached view assembled from validated scalar pages. */
export interface PointSeries {
  layers: readonly LayerId[];
  frames: readonly FrameSample[];
}

/** Create per build/location; later loads supersede pending work, and close calls dispose. */
export interface PointSeriesLoader {
  load(horizon: PointHorizon, signal?: AbortSignal): Promise<PointSeries>;
  dispose(): void;
}

export type LatestPayload = z.infer<typeof latestSchema>;
