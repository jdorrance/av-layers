import { INDEXED_GRID } from '../../../tests/model-fixtures.js';
import { expect, it } from 'vitest';
import { assertSparseCoverageHalo, coverageAtZoom, expectedTiles, isCovered, isTileCovered, prepareCoverageTester, setBit, type CoverageMask } from './coverage.js';
import { prepareGridGeometry, type Grid } from './geometry.js';
import { sparseCoverageFromDense } from './sparse-coverage.js';
import fixture from './fixtures/lambert.json';


it('selects rendered levels while preserving immutable cells and clearing prefix padding', () => {
  const master: CoverageMask = { grid: INDEXED_GRID, output: Uint8Array.of(1), halo: Uint8Array.of(2), tiles: Uint8Array.of(255, 255, 31), maxZoom: 2 };
  for (const [zoom, bytes] of [[0, [1]], [1, [31]]] as const) {
    const view = coverageAtZoom(master, zoom);
    expect(view.tiles).toEqual(Uint8Array.from(bytes));
    expect(view.grid).toBe(master.grid); expect(view.output).toBe(master.output); expect(view.halo).toBe(master.halo);
    for (let level = 0; level <= zoom; level++) expect(expectedTiles(view, level)).toEqual(expectedTiles(master, level));
    expect(expectedTiles(view, zoom + 1)).toEqual([]);
    expect(isTileCovered(view, zoom + 1, 0, 0)).toBe(false);
  }
  expect(master.tiles).toEqual(Uint8Array.of(255, 255, 31));
  expect(coverageAtZoom(master, 2)).toBe(master);
  for (const zoom of [-1, 1.5, NaN, 3]) expect(() => coverageAtZoom(master, zoom)).toThrow('coverage zoom');
  expect(() => coverageAtZoom({ ...master, tiles: Uint8Array.of(1) }, 2)).toThrow('Incomplete');
  const buffered = { ...master, tiles: Buffer.from(master.tiles) };
  expect(coverageAtZoom(buffered, 0).tiles).toEqual(Uint8Array.of(1));
  expect(buffered.tiles).toEqual(Buffer.from([255, 255, 31]));
  expect(expectedTiles(coverageAtZoom(buffered, 1), 1)).toHaveLength(4);
});

it('compiled coverage preserves exact direct ownership at grid edges, half-cell ties, bounds and wrap', () => {
  for (const grid of [INDEXED_GRID, { ...INDEXED_GRID, width: 3, height: 3, lon0: 10, lat0: 40, dx: 1, dy: -1, wrapLongitude: false }, fixture.grid] as Grid[]) {
    const mask: CoverageMask = { grid, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)).fill(0x55), halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: Uint8Array.of(1), maxZoom: 0 };
    const geometry = prepareGridGeometry(grid), covered = prepareCoverageTester(mask);
    for (const y of [-0.500001, -0.5, -0.499999, 0, 0.5, 1, grid.height - 1, grid.height - 0.5]) {
      for (const x of [-0.500001, -0.5, -0.499999, 0, 0.5, 1, grid.width - 1, grid.width - 0.5]) {
        const point = geometry.gridToGeographic(x, y);
        if (point) expect(covered(point.lat, point.lon)).toBe(isCovered(mask, point.lat, point.lon));
      }
    }
    for (const [lat, lon] of [[NaN, 0], [0, Infinity], [90, 180], [90, -180], [91, 0]]) expect(covered(lat, lon)).toBe(isCovered(mask, lat, lon));
    const bounded = { ...mask, bounds: [-10, -5, 10, 5] as const };
    expect(prepareCoverageTester(bounded)(40, 11)).toBe(false);
  }
});

it.each([false, true])('validates exact sparse halo and preserves dense admission with wrap=%s', wrapLongitude => {
  const grid = { ...INDEXED_GRID, width: 35, height: 20, lon0: -20, lat0: 20, dx: 1, dy: -1, wrapLongitude };
  const output = new Uint8Array(Math.ceil(grid.width * grid.height / 8)), halo = new Uint8Array(output.length);
  const points = [[0, 0], [15, 15], [16, 16], [34, 19], [25, 1]];
  const out = new Set(points.map(([x, y]) => y * grid.width + x));
  for (const index of out) setBit(output, index);
  for (const [x, y] of points) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const col = wrapLongitude ? ((x + dx) % grid.width + grid.width) % grid.width : x + dx, row = y + dy;
    if (col >= 0 && col < grid.width && row >= 0 && row < grid.height && !out.has(row * grid.width + col)) setBit(halo, row * grid.width + col);
  }
  const input = { ...grid, gridHash: 'a'.repeat(64), output, halo }, coverage = sparseCoverageFromDense(input);
  expect(() => assertSparseCoverageHalo(coverage)).not.toThrow();
  const dense = { grid, output, halo, tiles: Uint8Array.of(1), maxZoom: 0 }, sparse = { grid, coverage, tiles: dense.tiles, maxZoom: 0 };
  for (let y = 0; y < grid.height; y += 0.5) for (let x = 0; x < grid.width; x += 0.5) {
    expect(isCovered(sparse, grid.lat0 + y * grid.dy, grid.lon0 + x * grid.dx)).toBe(isCovered(dense, grid.lat0 + y * grid.dy, grid.lon0 + x * grid.dx));
  }
  const missing = halo.slice(); setBit(missing, 1, false);
  expect(() => assertSparseCoverageHalo(sparseCoverageFromDense({ ...input, halo: missing }))).toThrow('halo mismatch');
  const extra = halo.slice(); setBit(extra, 10);
  expect(() => assertSparseCoverageHalo(sparseCoverageFromDense({ ...input, halo: extra }))).toThrow('halo mismatch');
});

it('checks sparse halos at clipped, wrapped and missing block boundaries', () => {
  for (const width of [1, 2, 15, 16, 17, 31, 32, 33]) for (const height of [1, 2, 15, 16, 17]) for (const wrapLongitude of [false, true]) {
    const output = new Uint8Array(Math.ceil(width * height / 8)), halo = new Uint8Array(output.length);
    const points: [number, number][] = [[0, 0], [width - 1, height - 1], [Math.floor(width / 2), Math.floor(height / 2)]];
    const out = new Set(points.map(([x, y]) => y * width + x));
    for (const index of out) setBit(output, index);
    for (const [x, y] of points) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const col = wrapLongitude ? ((x + dx) % width + width) % width : x + dx, row = y + dy;
      if (col >= 0 && col < width && row >= 0 && row < height && !out.has(row * width + col)) setBit(halo, row * width + col);
    }
    const input = { width, height, wrapLongitude, gridHash: 'a'.repeat(64), output, halo };
    expect(() => assertSparseCoverageHalo(sparseCoverageFromDense(input)), `${width}x${height} wrap=${wrapLongitude}`).not.toThrow();
    for (let index = 0; index < width * height; index++) {
      if (out.has(index)) continue;
      const changed = halo.slice(); setBit(changed, index, !(halo[Math.floor(index / 8)] & (1 << (index % 8))));
      expect(() => assertSparseCoverageHalo(sparseCoverageFromDense({ ...input, halo: changed })), `${width}x${height} wrap=${wrapLongitude} cell=${index}`).toThrow('halo mismatch');
    }
  }
});

it('requires every halo-only neighbor block around output edges and corners', () => {
  for (const width of [33, 48, 49]) for (const height of [33, 48, 49]) for (const wrapLongitude of [false, true]) {
    for (const [x, y] of [[16, 16], [31, 16], [16, 31], [31, 31], [0, 16], [width - 1, 16], [16, 0], [16, height - 1]]) {
      const output = new Uint8Array(Math.ceil(width * height / 8)), halo = new Uint8Array(output.length), own = y * width + x;
      setBit(output, own);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = wrapLongitude ? ((x + dx) % width + width) % width : x + dx, yy = y + dy;
        if (xx >= 0 && xx < width && yy >= 0 && yy < height && yy * width + xx !== own) setBit(halo, yy * width + xx);
      }
      const input = { width, height, wrapLongitude, gridHash: 'a'.repeat(64), output, halo }, coverage = sparseCoverageFromDense(input), columns = Math.ceil(width / 16);
      expect(() => assertSparseCoverageHalo(coverage)).not.toThrow();
      for (const id of coverage.blockIds) {
        if (id === Math.floor(y / 16) * columns + Math.floor(x / 16)) continue;
        const missing = halo.slice(), x0 = id % columns * 16, y0 = Math.floor(id / columns) * 16;
        for (let yy = y0; yy < Math.min(y0 + 16, height); yy++) for (let xx = x0; xx < Math.min(x0 + 16, width); xx++) setBit(missing, yy * width + xx, false);
        expect(() => assertSparseCoverageHalo(sparseCoverageFromDense({ ...input, halo: missing }))).toThrow('halo mismatch');
      }
      const overlap = coverage.halo.slice();
      for (let byte = 0; byte < overlap.length; byte++) overlap[byte] |= coverage.output[byte];
      expect(() => assertSparseCoverageHalo({ ...coverage, halo: overlap })).toThrow('Invalid sparse coverage masks');
    }
  }
});
