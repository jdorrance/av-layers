import type { Grid } from '@av/contracts';
import { ICON_ARMENIA_MAX_CELLS, ICON_ARMENIA_MAX_EXPORT_DISTANCE_DEG, ICON_HALF_LEVELS, ICON_LEVEL_NUMBERS_ASCENDING, ICON_LEVELS } from './constants.ts';
import { IconAdapterError } from './fields.ts';
import type { IconArmeniaFrame, IconBounds, IconExportFrame, IconExportMapping, IconExtract, IconNativeCell } from './types.ts';

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const RAD = Math.PI / 180;

export function validateIconBounds(value: IconBounds | undefined): IconBounds {
  if (!value) throw new IconAdapterError('bounds', 'ICON bounding box is required');
  if (!(['west', 'south', 'east', 'north'] as const).every((key) => finite(value[key]))) {
    throw new IconAdapterError('bounds', 'ICON bounding box coordinates must be finite');
  }
  if (value.west < -180 || value.east > 180 || value.south < -90 || value.north > 90 || value.west >= value.east || value.south >= value.north) {
    throw new IconAdapterError('bounds', 'ICON bounding box is invalid');
  }
  return { west: value.west, south: value.south, east: value.east, north: value.north };
}

export function recordKey(field: string, hour: number, level: number | null = null): string {
  return `${field}:${hour}:${level === null ? 'None' : level}`;
}

function longitudeDelta(a: number, b: number): number {
  let delta = a - b;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function angularDistanceDeg(latA: number, lonA: number, latB: number, lonB: number): number {
  const dLat = latA - latB;
  const dLon = longitudeDelta(lonA, lonB) * Math.cos(((latA + latB) / 2) * RAD);
  return Math.hypot(dLat, dLon);
}

function median(values: number[]): number {
  if (!values.length) return ICON_ARMENIA_EXPORT_GRID_DEFAULT_SPACING;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const ICON_ARMENIA_EXPORT_GRID_DEFAULT_SPACING = 0.0625;

export function nativeSpacingDeg(cells: readonly IconNativeCell[]): number {
  if (cells.length < 2) return ICON_ARMENIA_EXPORT_GRID_DEFAULT_SPACING;
  const nearest: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < cells.length; j++) {
      if (i === j) continue;
      const distance = angularDistanceDeg(cells[i].latitude, cells[i].longitude, cells[j].latitude, cells[j].longitude);
      if (distance < best) best = distance;
    }
    if (Number.isFinite(best) && best > 0) nearest.push(best);
  }
  return median(nearest);
}

export function buildIconNativeGeometry(extract: IconExtract): {
  cells: IconNativeCell[];
  levelHeightsM: Float32Array;
  spacingDegEstimate: number;
} {
  const cells = extract.cells;
  if (!Array.isArray(cells) || !cells.length) throw new IconAdapterError('geometry-empty', 'ICON Armenia selection contains no native cells');
  if (cells.length > ICON_ARMENIA_MAX_CELLS) {
    throw new IconAdapterError('geometry-cap', `ICON Armenia selection ${cells.length} exceeds the admitted cap of ${ICON_ARMENIA_MAX_CELLS} cells`);
  }
  const seen = new Set<number>();
  for (const cell of cells) {
    if (!Number.isSafeInteger(cell.index) || cell.index < 0) throw new IconAdapterError('geometry-index', 'ICON native cell index must be a non-negative integer');
    if (seen.has(cell.index)) throw new IconAdapterError('geometry-index', `ICON native cell index ${cell.index} is duplicated`);
    seen.add(cell.index);
    if (!finite(cell.latitude) || cell.latitude < -90 || cell.latitude > 90 || !finite(cell.longitude) || cell.longitude < -180 || cell.longitude > 180) {
      throw new IconAdapterError('geometry-coordinate', 'ICON native cell coordinates are outside valid ranges');
    }
    if (!finite(cell.terrainM) || cell.terrainM < -500 || cell.terrainM > 9000) {
      throw new IconAdapterError('geometry-terrain', 'ICON native cell terrain is missing or outside the admitted range');
    }
  }
  const levelHeightsM = new Float32Array(cells.length * ICON_LEVELS.length);
  for (let cellPosition = 0; cellPosition < cells.length; cellPosition++) {
    const cell = cells[cellPosition];
    const half: number[] = [];
    for (const level of ICON_HALF_LEVELS) {
      const record = extract.records[recordKey('HHL', 0, level)];
      if (!record) throw new IconAdapterError('geometry-hhl', `ICON HHL level ${level} is unavailable`);
      if (record.metadata.units !== 'm') throw new IconAdapterError('geometry-hhl', `ICON HHL level ${level} units are not metres`);
      const value = record.values[cellPosition];
      if (!finite(value)) throw new IconAdapterError('geometry-hhl', `ICON HHL level ${level} is missing for native cell ${cell.index}`);
      half.push(value);
    }
    for (let i = 0; i + 1 < half.length; i++) {
      if (!(half[i] > half[i + 1])) {
        throw new IconAdapterError('geometry-hhl-order', `ICON HHL heights are not strictly descending at native cell ${cell.index}`);
      }
    }
    const bottom = half[half.length - 1];
    if (Math.abs(bottom - cell.terrainM) > 1) {
      throw new IconAdapterError('geometry-hhl-terrain', `ICON HHL bottom interface differs from model terrain at native cell ${cell.index}`);
    }
    let previous = cell.terrainM;
    for (let k = 0; k < ICON_LEVEL_NUMBERS_ASCENDING.length; k++) {
      const level = ICON_LEVEL_NUMBERS_ASCENDING[k];
      const position = ICON_HALF_LEVELS.indexOf(level);
      const height = (half[position] + half[position + 1]) / 2;
      if (!(height > previous)) {
        throw new IconAdapterError('geometry-hhl-order', `ICON cap heights are not ascending at native cell ${cell.index}`);
      }
      previous = height;
      levelHeightsM[cellPosition * ICON_LEVELS.length + k] = height;
    }
  }
  return { cells: cells.map((cell) => ({ ...cell })), levelHeightsM, spacingDegEstimate: nativeSpacingDeg(cells) };
}

export function validateExportGrid(grid: Grid): Grid {
  if (!Number.isInteger(grid.width) || grid.width <= 0 || !Number.isInteger(grid.height) || grid.height <= 0) {
    throw new IconAdapterError('export-grid', 'ICON export grid dimensions must be positive integers');
  }
  if (!finite(grid.lon0) || !finite(grid.lat0) || !finite(grid.dx) || !finite(grid.dy) || grid.dx === 0 || grid.dy === 0) {
    throw new IconAdapterError('export-grid', 'ICON export grid axes must be finite and non-zero');
  }
  return grid;
}

export function buildIconExportMapping(cells: readonly IconNativeCell[], grid: Grid, maxDistanceDeg = ICON_ARMENIA_MAX_EXPORT_DISTANCE_DEG): IconExportMapping {
  validateExportGrid(grid);
  if (!cells.length) throw new IconAdapterError('geometry-empty', 'ICON export mapping requires native cells');
  if (!finite(maxDistanceDeg) || maxDistanceDeg <= 0) throw new IconAdapterError('export-grid', 'ICON export mapping distance cap must be positive');
  const activeIndices: number[] = [];
  const nativeForExport: number[] = [];
  const distances: number[] = [];
  for (let row = 0; row < grid.height; row++) {
    const lat = grid.lat0 + row * grid.dy;
    if (lat < -90 || lat > 90) throw new IconAdapterError('export-grid', 'ICON export grid row lies outside valid latitudes');
    for (let column = 0; column < grid.width; column++) {
      let lon = grid.lon0 + column * grid.dx;
      if (grid.wrapLongitude) {
        lon = ((lon + 180) % 360 + 360) % 360 - 180;
      } else if (lon < -180 || lon > 180) {
        throw new IconAdapterError('export-grid', 'ICON export grid column lies outside valid longitudes');
      }
      let bestPosition = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let position = 0; position < cells.length; position++) {
        const distance = angularDistanceDeg(lat, lon, cells[position].latitude, cells[position].longitude);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestPosition = position;
        }
      }
      if (bestDistance <= maxDistanceDeg) {
        activeIndices.push(row * grid.width + column);
        nativeForExport.push(bestPosition);
        distances.push(bestDistance);
      }
    }
  }
  if (!activeIndices.length) throw new IconAdapterError('export-empty', 'ICON selected native cells do not cover the export grid');
  const sorted = [...distances].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return {
    policy: 'nearest-native',
    grid,
    activeIndices: Uint32Array.from(activeIndices),
    nativeForExport: Uint32Array.from(nativeForExport),
    distanceDeg: Float32Array.from(distances),
    maxDistanceDeg,
    distanceP95Deg: p95,
    nativeSpacingDeg: nativeSpacingDeg(cells),
    exportSpacingDeg: Math.min(Math.abs(grid.dx), Math.abs(grid.dy)),
  };
}

export function mapFrameToExport(
  frame: IconArmeniaFrame,
  mapping: IconExportMapping,
  levelHeightsM: Float32Array,
): IconExportFrame {
  const levelCount = ICON_LEVELS.length;
  const count = mapping.activeIndices.length;
  const result: IconExportFrame = {
    activeIndices: mapping.activeIndices,
    nativeForExport: mapping.nativeForExport,
    levelCount,
    terrainM: new Float32Array(count),
    levelHeightsM: new Float32Array(count * levelCount),
    surfacePressurePa: new Float32Array(count),
    temp2mK: new Float32Array(count),
    dewPoint2mK: new Float32Array(count),
    pblHeightM: new Float32Array(count),
    sensibleHeatFluxWm2: new Float32Array(count),
    latentHeatFluxWm2: new Float32Array(count),
    precipitationMmPerHour: new Float32Array(count),
    levelPressurePa: new Float32Array(count * levelCount),
    levelTemperatureK: new Float32Array(count * levelCount),
    missing: {
      surface: new Uint8Array(count),
      temp2m: new Uint8Array(count),
      dewPoint2m: new Uint8Array(count),
      pbl: new Uint8Array(count),
      sensible: new Uint8Array(count),
      latent: new Uint8Array(count),
      precipitation: new Uint8Array(count),
      level: new Uint8Array(count * levelCount),
    },
  };
  for (let position = 0; position < count; position++) {
    const source = mapping.nativeForExport[position];
    const flatSource = source * levelCount;
    const flatTarget = position * levelCount;
    result.terrainM[position] = frame.terrainM[source];
    result.surfacePressurePa[position] = frame.surfacePressurePa[source];
    result.temp2mK[position] = frame.temp2mK[source];
    result.dewPoint2mK[position] = frame.dewPoint2mK[source];
    result.pblHeightM[position] = frame.pblHeightM[source];
    result.sensibleHeatFluxWm2[position] = frame.sensibleHeatFluxWm2[source];
    result.latentHeatFluxWm2[position] = frame.latentHeatFluxWm2[source];
    result.precipitationMmPerHour[position] = frame.precipitationMmPerHour[source];
    result.missing.surface[position] = frame.missing.surface[source];
    result.missing.temp2m[position] = frame.missing.temp2m[source];
    result.missing.dewPoint2m[position] = frame.missing.dewPoint2m[source];
    result.missing.pbl[position] = frame.missing.pbl[source];
    result.missing.sensible[position] = frame.missing.sensible[source];
    result.missing.latent[position] = frame.missing.latent[source];
    result.missing.precipitation[position] = frame.missing.precipitation[source];
    for (let k = 0; k < levelCount; k++) {
      result.levelHeightsM[flatTarget + k] = levelHeightsM[flatSource + k];
      result.levelPressurePa[flatTarget + k] = frame.levelPressurePa[flatSource + k];
      result.levelTemperatureK[flatTarget + k] = frame.levelTemperatureK[flatSource + k];
      result.missing.level[flatTarget + k] = frame.missing.level[flatSource + k];
    }
  }
  return result;
}
