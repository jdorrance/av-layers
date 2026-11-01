import type { z } from 'zod';
import type { latestSchema, FreshnessSummary, LayerId, Manifest, ModelId, ModelPointer, SampleStatus } from './index.ts';

export interface PaletteSummary {
  id: string;
  edges: readonly number[];
  colors: readonly string[];
  units: string;
  noLiftColor?: string;
  transparentBelow?: number;
  provisional?: boolean;
}

export interface CoverageSummary {
  id: string;
  hash: string;
  maskKey: string;
  maxZoom: number;
  tileBits?: readonly number[];
}

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

export type LatestPayload = z.infer<typeof latestSchema>;
