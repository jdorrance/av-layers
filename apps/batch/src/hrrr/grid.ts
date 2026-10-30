import { lambertConeConstant, type LambertGrid } from '@azohra/meteo.grib';
import { HRRR_NATIVE_GRID } from './constants.ts';
import { NoaaError } from '../noaa/errors.ts';
import type { HrrrBounds, HrrrCellSelection, HrrrNativeGrid, HrrrPoint } from './types.ts';

const RAD = Math.PI / 180;
const wrap = (longitude: number) => ((longitude + 180) % 360 + 360) % 360 - 180;

function refuse(code: 'unsupported-grid' | 'unsupported-earth', message: string, details?: Record<string, unknown>): never {
  throw new NoaaError(code, message, details);
}

export function assertHrrrGrid(grid: LambertGrid, expectedGridKey?: string): void {
  if (grid.kind !== 'lambert') refuse('unsupported-grid', `HRRR requires Lambert GDT 3.30, got ${grid.kind}`);
  const checks: [string, unknown, unknown][] = [
    ['gridDefinitionTemplateNumber', grid.gridDefinitionTemplateNumber, HRRR_NATIVE_GRID.gridDefinitionTemplateNumber],
    ['gridKey', grid.gridKey, HRRR_NATIVE_GRID.gridKey],
    ['ni', grid.ni, HRRR_NATIVE_GRID.ni],
    ['nj', grid.nj, HRRR_NATIVE_GRID.nj],
    ['numberOfDataPoints', grid.numberOfDataPoints, HRRR_NATIVE_GRID.numberOfDataPoints],
    ['scanningMode', grid.scanningMode, HRRR_NATIVE_GRID.scanningMode],
    ['iScansNegatively', grid.iScansNegatively, HRRR_NATIVE_GRID.iScansNegatively],
    ['jScansPositively', grid.jScansPositively, HRRR_NATIVE_GRID.jScansPositively],
    ['jPointsAreConsecutive', grid.jPointsAreConsecutive, HRRR_NATIVE_GRID.jPointsAreConsecutive],
    ['alternativeRowScanning', grid.alternativeRowScanning, HRRR_NATIVE_GRID.alternativeRowScanning],
    ['resolutionAndComponentFlags', grid.resolutionAndComponentFlags, HRRR_NATIVE_GRID.resolutionAndComponentFlags],
    ['uvRelativeToGrid', grid.uvRelativeToGrid, HRRR_NATIVE_GRID.uvRelativeToGrid],
    ['latitudeOfFirstGridPoint', grid.latitudeOfFirstGridPoint, HRRR_NATIVE_GRID.latitudeOfFirstGridPoint],
    ['longitudeOfFirstGridPoint', grid.longitudeOfFirstGridPoint, HRRR_NATIVE_GRID.longitudeOfFirstGridPoint],
    ['laD', grid.laD, HRRR_NATIVE_GRID.laD],
    ['loV', grid.loV, HRRR_NATIVE_GRID.loV],
    ['dxM', grid.dxM, HRRR_NATIVE_GRID.dxM],
    ['dyM', grid.dyM, HRRR_NATIVE_GRID.dyM],
    ['projectionCentreFlag', grid.projectionCentreFlag, HRRR_NATIVE_GRID.projectionCentreFlag],
    ['latin1', grid.latin1, HRRR_NATIVE_GRID.latin1],
    ['latin2', grid.latin2, HRRR_NATIVE_GRID.latin2],
    ['southPoleLatitude', grid.southPoleLatitude, HRRR_NATIVE_GRID.southPoleLatitude],
    ['southPoleLongitude', grid.southPoleLongitude, HRRR_NATIVE_GRID.southPoleLongitude],
  ];
  const mismatch = checks.find(([, actual, expected]) => actual !== expected);
  if (mismatch) refuse('unsupported-grid', `HRRR native grid differs: ${mismatch[0]}`, { actual: mismatch[1], expected: mismatch[2] });
  if (grid.earthRadiusM !== HRRR_NATIVE_GRID.earthRadiusM) {
    refuse('unsupported-earth', `Unsupported HRRR earth radius ${grid.earthRadiusM}`);
  }
  if (expectedGridKey && grid.gridKey !== expectedGridKey) {
    refuse('unsupported-grid', 'HRRR field grid key differs from admitted frame geometry', { expectedGridKey, actualGridKey: grid.gridKey });
  }
}

export function lambertProjection(grid: LambertGrid) {
  const n = lambertConeConstant(grid.latin1, grid.latin2);
  const f = Math.cos(grid.latin1 * RAD) * Math.tan(Math.PI / 4 + grid.latin1 * RAD / 2) ** n / n;
  const rho = (latitude: number) => grid.earthRadiusM * f / Math.tan(Math.PI / 4 + latitude * RAD / 2) ** n;
  const rho0 = rho(grid.laD);
  const forward = (longitude: number, latitude: number): [number, number] => {
    const theta = n * wrap(longitude - grid.loV) * RAD;
    return [rho(latitude) * Math.sin(theta), rho0 - rho(latitude) * Math.cos(theta)];
  };
  const inverse = (x: number, y: number): [number, number] => [
    wrap(grid.loV + Math.atan2(x, rho0 - y) / n / RAD),
    (2 * Math.atan((grid.earthRadiusM * f / Math.hypot(x, rho0 - y)) ** (1 / n)) - Math.PI / 2) / RAD,
  ];
  const [x0, y0] = forward(grid.longitudeOfFirstGridPoint, grid.latitudeOfFirstGridPoint);
  const dx = grid.dxM * (grid.iScansNegatively ? -1 : 1);
  const dy = grid.dyM * (grid.jScansPositively ? 1 : -1);
  return {
    forward,
    inverse,
    point: (i: number, j: number): [number, number] => inverse(x0 + i * dx, y0 + j * dy),
    fractional: (longitude: number, latitude: number): [number, number] => {
      const [x, y] = forward(longitude, latitude);
      return [(x - x0) / dx, (y - y0) / dy];
    },
  };
}

export function storageIndex(grid: LambertGrid, i: number, j: number): number {
  if (grid.jPointsAreConsecutive) return i * grid.nj + (grid.alternativeRowScanning && i % 2 ? grid.nj - 1 - j : j);
  return j * grid.ni + (grid.alternativeRowScanning && j % 2 ? grid.ni - 1 - i : i);
}

export function storageCoordinates(grid: LambertGrid, index: number): [number, number] {
  if (grid.jPointsAreConsecutive) {
    const i = Math.floor(index / grid.nj), row = index % grid.nj;
    return [i, grid.alternativeRowScanning && i % 2 ? grid.nj - 1 - row : row];
  }
  const j = Math.floor(index / grid.ni), column = index % grid.ni;
  return [grid.alternativeRowScanning && j % 2 ? grid.ni - 1 - column : column, j];
}

export function hrrrNativeGrid(grid: LambertGrid): HrrrNativeGrid {
  assertHrrrGrid(grid);
  const projection = lambertProjection(grid);
  const corners = [
    [0, 0],
    [grid.ni - 1, 0],
    [grid.ni - 1, grid.nj - 1],
    [0, grid.nj - 1],
    [0, 0],
  ].map(([i, j]) => projection.point(i!, j!));
  return {
    kind: 'lambert',
    gridDefinitionTemplateNumber: 30,
    gridKey: grid.gridKey,
    ni: grid.ni,
    nj: grid.nj,
    numberOfDataPoints: grid.numberOfDataPoints,
    scanningMode: grid.scanningMode,
    iScansNegatively: grid.iScansNegatively,
    jScansPositively: grid.jScansPositively,
    jPointsAreConsecutive: grid.jPointsAreConsecutive,
    alternativeRowScanning: grid.alternativeRowScanning,
    resolutionAndComponentFlags: grid.resolutionAndComponentFlags,
    uvRelativeToGrid: grid.uvRelativeToGrid,
    earthRadiusM: grid.earthRadiusM,
    latitudeOfFirstGridPoint: grid.latitudeOfFirstGridPoint,
    longitudeOfFirstGridPoint: grid.longitudeOfFirstGridPoint,
    laD: grid.laD,
    loV: grid.loV,
    dxM: grid.dxM,
    dyM: grid.dyM,
    projectionCentreFlag: grid.projectionCentreFlag,
    latin1: grid.latin1,
    latin2: grid.latin2,
    southPoleLatitude: grid.southPoleLatitude,
    southPoleLongitude: grid.southPoleLongitude,
    corners,
  };
}

function assertBounds(bounds: HrrrBounds): void {
  if (
    !Number.isFinite(bounds.west) ||
    !Number.isFinite(bounds.south) ||
    !Number.isFinite(bounds.east) ||
    !Number.isFinite(bounds.north) ||
    bounds.west >= bounds.east ||
    bounds.south >= bounds.north
  ) {
    throw new NoaaError('invalid-option', 'Invalid HRRR bounds');
  }
}

export function selectHrrrCells(grid: LambertGrid, options: {
  bounds?: HrrrBounds;
  points?: readonly HrrrPoint[];
  indices?: readonly number[];
  maxCells?: number;
}): HrrrCellSelection {
  assertHrrrGrid(grid);
  const maxCells = options.maxCells ?? 12_000;
  if (!Number.isInteger(maxCells) || maxCells < 1) throw new NoaaError('invalid-option', 'maxCells must be a positive integer');
  const projection = lambertProjection(grid);
  const selected = new Set<number>();
  const add = (i: number, j: number) => {
    if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= grid.ni || j >= grid.nj) return false;
    selected.add(storageIndex(grid, i, j));
    if (selected.size > maxCells) throw new NoaaError('invalid-option', `HRRR selection exceeds ${maxCells} native cells`);
    return true;
  };
  for (const index of options.indices ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= grid.numberOfDataPoints) {
      throw new NoaaError('invalid-option', `HRRR native storage index out of range: ${index}`);
    }
    const [i, j] = storageCoordinates(grid, index);
    add(i, j);
  }
  for (const point of options.points ?? []) {
    if (!point.id || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude)) {
      throw new NoaaError('invalid-option', 'Invalid HRRR point selection');
    }
    const [fi, fj] = projection.fractional(point.longitude, point.latitude);
    if (!add(Math.round(fi), Math.round(fj))) {
      throw new NoaaError('invalid-option', `HRRR point ${point.id} is outside the native Lambert grid`);
    }
  }
  if (options.bounds) {
    assertBounds(options.bounds);
    const { west, south, east, north } = options.bounds;
    const edges = Array.from({ length: 101 }, (_, index) => index / 100).flatMap((t) => [
      projection.fractional(west + t * (east - west), south),
      projection.fractional(west + t * (east - west), north),
      projection.fractional(west, south + t * (north - south)),
      projection.fractional(east, south + t * (north - south)),
    ]);
    const xs = edges.map(([x]) => x), ys = edges.map(([, y]) => y);
    const firstI = Math.max(0, Math.floor(Math.min(...xs)) - 2);
    const lastI = Math.min(grid.ni - 1, Math.ceil(Math.max(...xs)) + 2);
    const firstJ = Math.max(0, Math.floor(Math.min(...ys)) - 2);
    const lastJ = Math.min(grid.nj - 1, Math.ceil(Math.max(...ys)) + 2);
    for (let j = firstJ; j <= lastJ; j++) for (let i = firstI; i <= lastI; i++) {
      const [longitude, latitude] = projection.point(i, j);
      if (longitude < west || longitude > east || latitude < south || latitude > north) continue;
      add(i, j);
    }
  }
  if (!selected.size) throw new NoaaError('invalid-option', 'HRRR selection selected no native cells');
  const cells = [...selected].sort((a, b) => a - b).map((index) => {
    const [i, j] = storageCoordinates(grid, index);
    const [longitude, latitude] = projection.point(i, j);
    const corners = [
      [-0.5, -0.5],
      [0.5, -0.5],
      [0.5, 0.5],
      [-0.5, 0.5],
      [-0.5, -0.5],
    ].map(([di, dj]) => projection.point(i + di!, j + dj!));
    return { index, i, j, longitude, latitude, corners };
  });
  return { grid: hrrrNativeGrid(grid), cells, indexing: 'hrrr-native-lambert-storage' };
}
