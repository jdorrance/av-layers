import type { LayerId } from '@av/contracts/layers';
import type { ProfileResponse } from '@av/contracts/point-products';
import type { latestV5Schema, ManifestV5, sampleResponseV5Schema } from '@av/contracts/publication';

export type PaletteSummary = ManifestV5['descriptors']['palettes'][number];
export type SamplePayload = ReturnType<typeof sampleResponseV5Schema.parse>;
export type FrameSample = SamplePayload['frames'][number];
export type FrameSampleLayer = FrameSample['layers'][string];
export type PointFrame = FrameSample & Partial<Pick<ProfileResponse['frames'][number], 'profile' | 'derived'>>;

export interface PinnedBuild {
  manifest: ManifestV5;
  templates: Partial<Record<LayerId, string>>;
  expiresAtMs: number;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

export type PointHorizon = 'day' | 'forecast';

/** A bounded cached view whose frames can gain scalar or profile data on later progress. */
export interface PointSeries {
  layers: readonly LayerId[];
  frames: readonly PointFrame[];
}

/** Create per build/location; later loads supersede pending work, and close calls dispose. */
export interface PointSeriesLoader {
  load(horizon: PointHorizon, signal?: AbortSignal, options?: {
    frameId?: string | null;
    /** Loading tracks outstanding routes, including profiles for frames with samples. */
    onProgress?(series: PointSeries, totalFrames: number, loading: boolean): void;
  }): Promise<PointSeries>;
  dispose(): void;
}

export type LatestPayload = ReturnType<typeof latestV5Schema.parse>;
