import { isValidGridGeometry, MAX_GRID_CELLS, type RegularLatLonGrid } from '@av/contracts';

const RAD = Math.PI / 180;
const BINS_PER_DEGREE = 4;
const COLUMNS = 360 * BINS_PER_DEGREE;
const ROWS = 180 * BINS_PER_DEGREE;
export const MAX_NATIVE_MAPPING_DISTANCE_M = 10_000;
const longitudeBin = (longitude: number) => ((Math.floor((longitude + 180) * BINS_PER_DEGREE) % COLUMNS) + COLUMNS) % COLUMNS;
const latitudeBin = (latitude: number) => Math.max(0, Math.min(ROWS - 1, Math.floor((latitude + 90) * BINS_PER_DEGREE)));

/** Map active output cells to their nearest native centre within 10 km; the caller owns the returned indices. */
export function prepareNativeMapping(grid: RegularLatLonGrid, activeIndices: Uint32Array,
  latitudes: Float32Array | Float64Array, longitudes: Float32Array | Float64Array
): Uint32Array {
  const cells = grid.width * grid.height;
  if (grid.kind !== 'regular-latlon' || !isValidGridGeometry(grid) || cells > MAX_GRID_CELLS ||
      !(activeIndices instanceof Uint32Array) || !activeIndices.length || activeIndices.length > cells ||
      ![latitudes, longitudes].every(values => values instanceof Float32Array || values instanceof Float64Array) ||
      !latitudes.length || latitudes.length !== longitudes.length || latitudes.length > MAX_GRID_CELLS) {
    throw new RangeError('Invalid native mapping dimensions');
  }
  for (let i = 0; i < latitudes.length; i++) {
    if (!Number.isFinite(latitudes[i]) || Math.abs(latitudes[i]!) > 90 ||
        !Number.isFinite(longitudes[i]) || Math.abs(longitudes[i]!) > 180) throw new RangeError(`Invalid native coordinate ${i}`);
  }
  for (const index of activeIndices) {
    if (index >= cells || Math.abs(grid.lat0 + Math.floor(index / grid.width) * grid.dy) > 90) {
      throw new RangeError(`Invalid native mapping target ${index}`);
    }
  }

  const heads = new Int32Array(COLUMNS * ROWS).fill(-1), next = new Int32Array(latitudes.length);
  const x = new Float64Array(latitudes.length), y = new Float64Array(latitudes.length), z = new Float64Array(latitudes.length);
  for (let i = 0; i < latitudes.length; i++) {
    const latitude = latitudes[i]!, longitude = longitudes[i]!, cosLatitude = Math.cos(latitude * RAD);
    x[i] = cosLatitude * Math.cos(longitude * RAD); y[i] = cosLatitude * Math.sin(longitude * RAD); z[i] = Math.sin(latitude * RAD);
    const bin = latitudeBin(latitude) * COLUMNS + longitudeBin(longitude);
    next[i] = heads[bin]!; heads[bin] = i;
  }

  const mapping = new Uint32Array(activeIndices.length);
  const angularRadius = Math.min(Math.PI, MAX_NATIVE_MAPPING_DISTANCE_M / grid.earthRadiusM), latitudeRadius = angularRadius / RAD;
  const maxChordSquared = (2 * Math.sin(angularRadius / 2)) ** 2;
  for (let slot = 0; slot < activeIndices.length; slot++) {
    const index = activeIndices[slot]!, row = Math.floor(index / grid.width);
    const latitude = grid.lat0 + row * grid.dy, longitude = ((grid.lon0 + (index - row * grid.width) * grid.dx + 180) % 360 + 360) % 360 - 180;
    const cosLatitude = Math.cos(latitude * RAD);
    const tx = cosLatitude * Math.cos(longitude * RAD), ty = cosLatitude * Math.sin(longitude * RAD), tz = Math.sin(latitude * RAD);
    const longitudeRadius = Math.abs(latitude) + latitudeRadius >= 90 ? 180 : Math.asin(Math.sin(angularRadius) / cosLatitude) / RAD;
    const firstColumn = Math.floor((longitude - longitudeRadius + 180) * BINS_PER_DEGREE);
    const columnCount = Math.min(COLUMNS, Math.floor((longitude + longitudeRadius + 180) * BINS_PER_DEGREE) - firstColumn + 1);
    const firstRow = latitudeBin(latitude - latitudeRadius), lastRow = latitudeBin(latitude + latitudeRadius);
    let nearest = -1, best = maxChordSquared;
    for (let sourceRow = firstRow; sourceRow <= lastRow; sourceRow++) {
      for (let offset = 0; offset < columnCount; offset++) {
        const column = ((firstColumn + offset) % COLUMNS + COLUMNS) % COLUMNS;
        for (let source = heads[sourceRow * COLUMNS + column]!; source >= 0; source = next[source]!) {
          const distance = (x[source]! - tx) ** 2 + (y[source]! - ty) ** 2 + (z[source]! - tz) ** 2;
          if (distance < best || (distance === best && (nearest === -1 || source < nearest))) { nearest = source; best = distance; }
        }
      }
    }
    if (nearest === -1) throw new Error(`No native cell within ${MAX_NATIVE_MAPPING_DISTANCE_M} m of output cell ${index}`);
    mapping[slot] = nearest;
  }
  return mapping;
}
