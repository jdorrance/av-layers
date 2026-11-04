/** Shared storage and wire-format limits consumed by producers and readers. */
export const CELL_BYTES = 5;
export const SAMPLE_BLOCK_SIZE = 16;
export const MAX_SAMPLE_VALUES = 256;
export const MAX_SAMPLE_RANGE_BYTES = 256 * 1024;
export const RETENTION_DAYS = 7;
export const MAX_RETAINED_BUILDS = 256;
export const MAX_NATIVE_ZOOM = 9;
export const RASTER_TILE_SIZE = 256;
export const MAX_TILE_BYTES = 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 30_000;
