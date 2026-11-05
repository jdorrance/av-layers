import { DEG, WGS84_A, TILE_SIZE, MAX_ZOOM, BLOCK_PX, DEFAULT_RADIUS_KM } from './constants.ts';
import type { ElevationGrid, TerrainBounds, TerrainDomain, SolarSite, SolarDomainOptions } from './types.ts';
// ── Web Mercator ────────────────────────────────────────────────────────────

const worldSize = (z: number) => TILE_SIZE * 2 ** z;
export const lonToX = (lon: number, z: number) => ((lon + 180) / 360) * worldSize(z);
export function latToY(lat: number, z: number) {
  const s = Math.sin(lat * DEG);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldSize(z);
}
export const xToLon = (x: number, z: number) => (x / worldSize(z)) * 360 - 180;
export const yToLat = (y: number, z: number) => Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / worldSize(z)))) / DEG;
/** Ground size of one pixel (m) at a latitude; Mercator pixels are square on the ground. */
export const metresPerPixel = (lat: number, z: number) => (2 * Math.PI * WGS84_A * Math.cos(lat * DEG)) / worldSize(z);

/** Metres per degree of latitude and longitude on the WGS84 ellipsoid. */
export function metresPerDegree(lat: number) {
  const p = lat * DEG;
  return {
    lat: 111132.954 - 559.822 * Math.cos(2 * p) + 1.175 * Math.cos(4 * p),
    lon: 111412.84 * Math.cos(p) - 93.5 * Math.cos(3 * p),
  };
}

// ── Elevation grids ─────────────────────────────────────────────────────────

/**
 * A north-up geographic elevation grid. Pixel (col, row) covers
 * [west + col*dLon, west + (col+1)*dLon] x [north - (row+1)*dLat, north - row*dLat];
 * values are metres, NaN where there is no data.
 * @typedef {{ values: Float32Array, width: number, height: number, west: number, north: number, dLon: number, dLat: number }} Grid
 */

/** Bilinear elevation at (lat, lon); NaN outside the grid or next to missing data. */
export function sampleGrid(grid: ElevationGrid, lat: number, lon: number) {
  return bilinearAt(grid.values, grid.width, grid.height, (lon - grid.west) / grid.dLon - 0.5, (grid.north - lat) / grid.dLat - 0.5);
}

/** Bilinear interpolation at fractional pixel-centre coordinates (x, y); NaN outside. */
export function bilinearAt(values: Float32Array, width: number, height: number, x: number, y: number) {
  if (!(x >= -0.5 && y >= -0.5 && x <= width - 0.5 && y <= height - 0.5)) return Number.NaN;
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  const x0 = Math.min(Math.floor(cx), width - 2 < 0 ? 0 : width - 2);
  const y0 = Math.min(Math.floor(cy), height - 2 < 0 ? 0 : height - 2);
  const x1 = Math.min(x0 + 1, width - 1);
  const y1 = Math.min(y0 + 1, height - 1);
  const fx = cx - x0;
  const fy = cy - y0;
  const a = values[y0 * width + x0];
  const b = values[y0 * width + x1];
  const c = values[y1 * width + x0];
  const d = values[y1 * width + x1];
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

// ── Domain ──────────────────────────────────────────────────────────────────

/** A domain from a zoom-14 pixel box [x0, x1) x [y0, y1), with its geographic bounds. */
function boxDomain(x0: number, y0: number, x1: number, y1: number): TerrainDomain {
  return {
    x0, y0, x1, y1,
    bounds: { south: yToLat(y1, MAX_ZOOM), west: xToLon(x0, MAX_ZOOM), north: yToLat(y0, MAX_ZOOM), east: xToLon(x1, MAX_ZOOM) },
  };
}

/**
 * The square of zoom-14 tiles covering `radiusKm` around a point. Returns the
 * zoom-14 pixel box [x0, x1) x [y0, y1) and its geographic bounds.
 */
function domainFor(latitude: number, longitude: number, radiusKm: number): TerrainDomain {
  const cx = lonToX(longitude, MAX_ZOOM);
  const cy = latToY(latitude, MAX_ZOOM);
  const r = (radiusKm * 1000) / metresPerPixel(latitude, MAX_ZOOM);
  const x0 = Math.floor((cx - r) / TILE_SIZE) * TILE_SIZE;
  const y0 = Math.floor((cy - r) / TILE_SIZE) * TILE_SIZE;
  const x1 = (Math.floor((cx + r) / TILE_SIZE) + 1) * TILE_SIZE;
  const y1 = (Math.floor((cy + r) / TILE_SIZE) + 1) * TILE_SIZE;
  return boxDomain(x0, y0, x1, y1);
}

/** The zoom-14 tiles covering a geographic box (a launch's own area, see sunlight-areas.json). */
function domainForBounds({ south, west, north, east }: TerrainBounds): TerrainDomain {
  const x0 = Math.floor(lonToX(west, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const y0 = Math.floor(latToY(north, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const x1 = Math.ceil(lonToX(east, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  const y1 = Math.ceil(latToY(south, MAX_ZOOM) / TILE_SIZE) * TILE_SIZE;
  return boxDomain(x0, y0, x1, y1);
}

/** A launch's sunlight-map domain: its own area when it has one, else the square of `radiusKm` around it. */
export function domainOf(site: SolarSite, { radiusKm = DEFAULT_RADIUS_KM, area }: SolarDomainOptions = {}): TerrainDomain {
  return area ? domainForBounds(area) : domainFor(site.latitude, site.longitude, radiusKm);
}

/**
 * Splits a domain into blocks of at most BLOCK_PX x BLOCK_PX zoom-14 pixels,
 * on a grid aligned to zoom-11 tiles, so every tile of every zoom lies in
 * exactly one block and a large area is built one block at a time.
 */
export function blocksOf(domain: TerrainDomain): TerrainDomain[] {
  const blocks = [];
  for (let by = Math.floor(domain.y0 / BLOCK_PX) * BLOCK_PX; by < domain.y1; by += BLOCK_PX) {
    for (let bx = Math.floor(domain.x0 / BLOCK_PX) * BLOCK_PX; bx < domain.x1; bx += BLOCK_PX) {
      blocks.push(boxDomain(Math.max(bx, domain.x0), Math.max(by, domain.y0), Math.min(bx + BLOCK_PX, domain.x1), Math.min(by + BLOCK_PX, domain.y1)));
    }
  }
  return blocks;
}

/** Pad an ordered, unwrapped geographic box by a nonnegative distance; reachable poles cover all longitudes. */
export function expandBounds(bounds: TerrainBounds, metres: number): TerrainBounds {
  if (!Number.isFinite(metres) || metres < 0 || ![bounds.south, bounds.north, bounds.west, bounds.east].every(Number.isFinite)
    || bounds.south < -90 || bounds.north > 90 || bounds.south > bounds.north || bounds.west > bounds.east) throw new RangeError('Expected finite ordered geographic bounds and nonnegative padding');
  if (metres === 0) return { ...bounds };
  // Exact ellipsoid radii for a coverage bound. The shorter series used by
  // metresPerDegree is retained for the existing terrain raster calculations.
  const e2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
  const scale = (latitude: number) => {
    const phi = latitude * DEG, w = 1 - e2 * Math.sin(phi) ** 2;
    return { lat: WGS84_A * (1 - e2) / w ** 1.5 * DEG, lon: WGS84_A / Math.sqrt(w) * Math.cos(phi) * DEG };
  };
  // The meridian scale is smallest at the equator. First bound the complete
  // padded latitude interval, then use its minimum scale, including 0° when
  // crossed. This keeps the expansion conservative in either hemisphere.
  const maxPadding = metres / scale(0).lat;
  const lower = Math.max(-90, bounds.south - maxPadding), upper = Math.min(90, bounds.north + maxPadding);
  const closest = lower <= 0 && upper >= 0 ? 0 : Math.min(Math.abs(lower), Math.abs(upper));
  const paddingLat = metres / scale(closest).lat;
  const south = Math.max(-90, bounds.south - paddingLat), north = Math.min(90, bounds.north + paddingLat);
  // Longitude spacing shrinks toward either pole. Use the entire padded
  // interval; a reachable pole requires all longitudes.
  const paddingLon = metres / scale(Math.max(Math.abs(south), Math.abs(north))).lon;
  const allLongitudes = south === -90 || north === 90 || bounds.east - bounds.west + 2 * paddingLon >= 360;
  // Keep the input's longitude branch: rasters sample unwrapped coordinates.
  const longitudePadding = allLongitudes ? Math.max(0, (360 - (bounds.east - bounds.west)) / 2) : paddingLon;
  return {
    south, north,
    west: bounds.west - longitudePadding,
    east: bounds.east + longitudePadding,
  };
}

