import { geographicToGrid, prepareGridGeometry, snapGridCoordinate, withinGeographicBounds, type GeographicBounds, type Grid } from './geometry.js';
import { getBit } from './bits.js';
export { getBit } from './bits.js';
import { sparseCoverageLookup, type SparseCoverage } from './sparse-coverage.js';

export interface CoverageMask { grid: Grid; bounds?: GeographicBounds; output: Uint8Array; halo: Uint8Array; tiles: Uint8Array; maxZoom: number }
export interface SparseCoverageMask { grid: Grid; bounds?: GeographicBounds; coverage: SparseCoverage; tiles: Uint8Array; maxZoom: number }

function coveredCoordinate(mask: CoverageMask | SparseCoverageMask, x: number, y: number): boolean {
  const { grid } = mask;
  if (!Number.isFinite(x) || !Number.isFinite(y) || (!grid.wrapLongitude && (x < -0.5 || x > grid.width - 0.5)) || y < -0.5 || y > grid.height - 0.5) return false;
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
  const c0 = grid.wrapLongitude ? ((x0 % grid.width) + grid.width) % grid.width : x0;
  const c1 = grid.wrapLongitude ? (((x0 + 1) % grid.width) + grid.width) % grid.width : x0 + 1;
  const col = fx === 0 ? c0 : fx < 0.5 ? c0 : fx > 0.5 ? c1 : Math.min(c0, c1);
  const row = fy <= 0.5 ? Math.max(0, y0) : Math.min(grid.height - 1, y0 + 1);
  if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) return false;
  return 'coverage' in mask ? sparseCoverageLookup(mask.coverage, col, row)?.output === true : getBit(mask.output, row * grid.width + col);
}
export function isCovered(mask: CoverageMask | SparseCoverageMask, lat: number, lon: number): boolean {
  if (!withinGeographicBounds(lat, lon, mask.bounds)) return false;
  const { grid } = mask;
  // Keep the regular-grid hot path allocation-free except for the result-free arithmetic.
  let x: number, y: number;
  if (grid.kind === 'regular-latlon') {
    x = snapGridCoordinate((lon - grid.lon0) / grid.dx);
    y = snapGridCoordinate((lat - grid.lat0) / grid.dy);
    if (grid.wrapLongitude) x = snapGridCoordinate(((x % grid.width) + grid.width) % grid.width);
  } else {
    const point = geographicToGrid(grid, lat, lon);
    if (!point) return false;
    ({ x, y } = point);
  }
  return coveredCoordinate(mask, x, y);
}
/** Compile projected coordinates once while preserving the same nearest-cell ownership as isCovered. */
export function prepareCoverageTester(mask: CoverageMask | SparseCoverageMask): (lat: number, lon: number) => boolean {
  if (mask.grid.kind === 'regular-latlon') return (lat, lon) => isCovered(mask, lat, lon);
  const geometry = prepareGridGeometry(mask.grid);
  return (lat, lon) => {
    if (!withinGeographicBounds(lat, lon, mask.bounds)) return false;
    const point = geometry.geographicToGrid(lat, lon);
    return !!point && coveredCoordinate(mask, point.x, point.y);
  };
}
