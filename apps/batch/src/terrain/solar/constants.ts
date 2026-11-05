import { SOLAR_TERRAIN_FORMAT } from '@av/contracts';

export const { schemaVersion: SCHEMA_VERSION, algorithmVersion: ALGORITHM_VERSION, tileSize: TILE_SIZE,
  minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM, horizonZoom: HORIZON_ZOOM, horizonCells: HORIZON_CELLS,
  horizonBorder: HORIZON_BORDER, azimuthsDeg: AZIMUTHS_DEG, horizonStepDeg: HORIZON_STEP_DEG } = SOLAR_TERRAIN_FORMAT;
export const DEFAULT_RADIUS_KM = 15;
export const DEFAULT_MAX_DISTANCE_KM = 20;
/**
 * Side of the blocks a domain is built in, in zoom-14 pixels (16 tiles, variable ground width):
 * a multiple of a zoom-11 tile, so no tile spans two blocks. Memory then stays
 * the same however large a launch's area is.
 */
export const BLOCK_PX = 16 * TILE_SIZE;
/** Metres of fine elevation read around a block (the normals' border and the relief's outer corners). */
export const FINE_MARGIN_M = 250;

export const DEG = Math.PI / 180;
export const WGS84_A = 6378137;
export const MEAN_EARTH_RADIUS_M = 6371008.8;
/** Standard terrestrial refraction coefficient: light bends over the curve, lifting distant terrain slightly. */
export const REFRACTION_K = 0.13;
export const CELL_PX = TILE_SIZE / HORIZON_CELLS;
export const HORIZON_SIDE = HORIZON_CELLS + 2 * HORIZON_BORDER;


export const round = (v: number, digits: number): number | null => (Number.isFinite(v) ? Number(v.toFixed(digits)) : null);
