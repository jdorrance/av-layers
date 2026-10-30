import { readFileSync } from 'node:fs';
import { parseGrid, type LambertGrid } from '@azohra/meteo.grib';
import { describe, expect, it } from 'vitest';
import { HRRR_NATIVE_GRID } from './constants.ts';
import { assertHrrrGrid, hrrrNativeGrid, selectHrrrCells, storageCoordinates, storageIndex } from './grid.ts';

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const grid = parseGrid(fixture('hrrr-lambert.section3.bin')) as LambertGrid;

describe('HRRR native Lambert geometry', () => {
  it('admits the live CONUS Lambert grid and exposes separate native geometry', () => {
    expect(grid.kind).toBe('lambert');
    expect(() => assertHrrrGrid(grid)).not.toThrow();
    const native = hrrrNativeGrid(grid);
    expect(native.gridKey).toBe(HRRR_NATIVE_GRID.gridKey);
    expect(native.ni).toBe(1799);
    expect(native.nj).toBe(1059);
    expect(native.jScansPositively).toBe(true);
    expect(native.jPointsAreConsecutive).toBe(false);
    expect(native.corners).toHaveLength(5);
    expect(native.corners[0]![0]).toBeCloseTo(-122.719528, 5);
    expect(native.corners[0]![1]).toBeCloseTo(21.138123, 5);
  });

  it('uses native storage indexing rather than GFS row/column assumptions', () => {
    expect(storageIndex(grid, 0, 0)).toBe(0);
    expect(storageIndex(grid, 1, 0)).toBe(1);
    expect(storageIndex(grid, 0, 1)).toBe(grid.ni);
    expect(storageCoordinates(grid, grid.ni)).toEqual([0, 1]);
    expect(storageCoordinates(grid, grid.ni + 5)).toEqual([5, 1]);
  });

  it('selects bounded native cells around Torrey Pines without a GFS mask index', () => {
    const selection = selectHrrrCells(grid, {
      bounds: { west: -117.45, south: 32.75, east: -117.05, north: 33.05 },
      points: [{ id: 'torrey-pines', latitude: 32.9, longitude: -117.25 }],
      maxCells: 2_000,
    });
    expect(selection.indexing).toBe('hrrr-native-lambert-storage');
    expect(selection.cells.length).toBeGreaterThan(0);
    expect(selection.cells.length).toBeLessThanOrEqual(2_000);
    for (const cell of selection.cells) {
      expect(cell.index).toBe(storageIndex(grid, cell.i, cell.j));
      expect(cell.latitude).toBeGreaterThanOrEqual(32.75);
      expect(cell.latitude).toBeLessThanOrEqual(33.05);
      expect(cell.longitude).toBeGreaterThanOrEqual(-117.45);
      expect(cell.longitude).toBeLessThanOrEqual(-117.05);
    }
  });

  it('rejects GFS-style grids and changed scan or earth metadata', () => {
    const changedScan = { ...grid, jScansPositively: false } as LambertGrid;
    const changedEarth = { ...grid, earthRadiusM: 6_371_000 } as LambertGrid;
    expect(() => assertHrrrGrid(changedScan)).toThrow(/native grid differs/);
    expect(() => assertHrrrGrid(changedEarth)).toThrow(/earth radius/);
  });
});
