/** Daylight for regular or projected grids, without any forecast/model dependency. */
import { DEFAULT_HORIZON_DEG } from './parameters.js';
import { DEG_TO_RAD, clamp, mod } from './geometry.js';
import { solarEphemeris } from './position.js';

export type RegularLatLonGridShape =
  | {
      readonly kind: 'regular-latlon';
      readonly width: number;
      readonly height: number;
      readonly lat0: number;
      readonly lon0: number;
      readonly dx: number;
      readonly dy: number;
    }
  | {
      readonly kind: 'regular-latlon';
      readonly width: number;
      readonly height: number;
      readonly north: number;
      readonly west: number;
      readonly dLat: number;
      readonly dLon: number;
    };

export interface ProjectedGridShape {
  readonly kind: 'projected';
  readonly width: number;
  readonly height: number;
  readonly gridToGeographic: (
    col: number,
    row: number
  ) => { readonly lat: number; readonly lon: number } | null;
}

export type DaylightGridShape = RegularLatLonGridShape | ProjectedGridShape;

/**
 * Precomputes separable row/column ephemeris tables so full-grid daylight checks
 * require zero per-cell trigonometric calls on regular lat/lon grids.
 */
export const createGridDaylightTester = (
  grid: DaylightGridShape,
  timestampsMs: readonly number[],
  horizonDeg = DEFAULT_HORIZON_DEG
): ((cellIndex: number) => boolean) => {
  const { width, height } = grid;
  const totalCells = width * height;
  const validTimestamps = timestampsMs.filter((ms): ms is number => Number.isFinite(ms));
  if (validTimestamps.length === 0) {
    return (cellIndex: number) =>
      Number.isInteger(cellIndex) && cellIndex >= 0 && cellIndex < totalCells;
  }

  const sinHorizon = Math.sin(horizonDeg * DEG_TO_RAD);
  const ephemerides = validTimestamps.map((ms) => solarEphemeris(ms));
  const timeCount = ephemerides.length;
  const sinDecl = Float64Array.from(ephemerides, (e) => e.sinDeclination);
  const cosDecl = Float64Array.from(ephemerides, (e) => e.cosDeclination);

  if (grid.kind === 'regular-latlon') {
    const lat0 = 'lat0' in grid ? grid.lat0 : grid.north;
    const lon0 = 'lon0' in grid ? grid.lon0 : grid.west;
    const dx = 'dx' in grid ? grid.dx : grid.dLon;
    const dy = 'dy' in grid ? grid.dy : -grid.dLat;

    const sinLat = new Float64Array(height);
    const cosLat = new Float64Array(height);
    for (let row = 0; row < height; row += 1) {
      const latRad = clamp(lat0 + row * dy, -89.999, 89.999) * DEG_TO_RAD;
      sinLat[row] = Math.sin(latRad);
      cosLat[row] = Math.cos(latRad);
    }

    const cosHourAngleByTime = ephemerides.map((ephemeris) => {
      const table = new Float64Array(width);
      const baseSolarMinutes = ephemeris.utcMinutes + ephemeris.equationOfTimeMin;
      for (let col = 0; col < width; col += 1) {
        const lonDeg = lon0 + col * dx;
        const trueSolarTimeMin = mod(baseSolarMinutes + 4 * lonDeg, 1440);
        const hourAngleDeg = trueSolarTimeMin / 4 - 180;
        table[col] = Math.cos(hourAngleDeg * DEG_TO_RAD);
      }
      return table;
    });

    return (cellIndex: number): boolean => {
      if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= totalCells) {
        return false;
      }
      const row = Math.floor(cellIndex / width);
      const col = cellIndex - row * width;
      const sLat = sinLat[row]!;
      const cLat = cosLat[row]!;
      for (let t = 0; t < timeCount; t += 1) {
        const sinElevation =
          sLat * sinDecl[t]! + cLat * cosDecl[t]! * cosHourAngleByTime[t]![col]!;
        if (sinElevation > sinHorizon) {
          return true;
        }
      }
      return false;
    };
  }

  const { gridToGeographic } = grid;
  const baseSolarMinutesByTime = Float64Array.from(
    ephemerides,
    (e) => e.utcMinutes + e.equationOfTimeMin
  );
  return (cellIndex: number): boolean => {
    if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex >= totalCells) {
      return false;
    }
    const row = Math.floor(cellIndex / width);
    const col = cellIndex - row * width;
    const point = gridToGeographic(col, row);
    if (!point || !Number.isFinite(point.lat) || !Number.isFinite(point.lon)) {
      return false;
    }
    const latRad = clamp(point.lat, -89.999, 89.999) * DEG_TO_RAD;
    const sLat = Math.sin(latRad);
    const cLat = Math.cos(latRad);
    for (let t = 0; t < timeCount; t += 1) {
      const trueSolarTimeMin = mod(baseSolarMinutesByTime[t]! + 4 * point.lon, 1440);
      const hourAngleDeg = trueSolarTimeMin / 4 - 180;
      const sinElevation =
        sLat * sinDecl[t]! + cLat * cosDecl[t]! * Math.cos(hourAngleDeg * DEG_TO_RAD);
      if (sinElevation > sinHorizon) {
        return true;
      }
    }
    return false;
  };
};
