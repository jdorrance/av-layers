import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { PMTiles } from 'pmtiles';
import { isCovered, paletteColor, setBit, STATUS_NO_LIFT, STATUS_UNAVAILABLE, type CoverageMask, type Grid, type LayerId } from '@av/contracts';
import { parseRefinementConfig, planRefinements, refinementCandidate } from '@av/contracts/refinement';
import { QUAD_OFFSETS, sampleGrid, type GridField } from '@av/forecast';
import { createRenderer, mercatorPoint, renderTileRgba } from './render.js';
import type { RasterPatch } from './raster.js';
import { createRasterPool } from './raster-pool.js';
import { decodeWebp } from './webp.js';

const layer = 'usable-lift-agl', tile = { z: 6, x: 34, y: 24 };
const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function maskFor(grid: Grid): CoverageMask {
  const bytes = Math.ceil(grid.width * grid.height / 8);
  const mask = { grid, output: new Uint8Array(bytes).fill(255), halo: new Uint8Array(bytes), tiles: new Uint8Array(Math.ceil(((4 ** 7 - 1) / 3) / 8)), maxZoom: 6 };
  setBit(mask.tiles, (4 ** tile.z - 1) / 3 + tile.y * 2 ** tile.z + tile.x);
  return mask;
}
function fixture() {
  const mask = maskFor({ kind: 'regular-latlon', width: 20, height: 20, lon0: 5, lat0: 45, dx: 1, dy: -1, earthRadiusM: 6371229, wrapLongitude: false });
  const config = parseRefinementConfig({ type: 'FeatureCollection', features: [{ type: 'Feature', id: 'zone-001', properties: {}, geometry: { type: 'Polygon', coordinates: [
    [[12, 37], [16, 37], [16, 40], [12, 40], [12, 37]],
    [[13, 38], [14, 38], [14, 39], [13, 39], [13, 38]]
  ] } }] });
  const [plan] = planRefinements(config, { sourceGrid: mask.grid, bounds: [5, 26, 24, 45], haloCells: 1 });
  const patch: RasterPatch = { id: plan.id, geometry: plan.geometry, descriptors: { bounds: plan.bounds }, layers: [layer], mask: { ...maskFor(plan.grid), bounds: plan.bounds } };
  const field = (grid: Grid, value: number): GridField => ({ values: new Float32Array(grid.width * grid.height).fill(value), flags: new Uint8Array(grid.width * grid.height) });
  return { mask, patch, base: field(mask.grid, 700), fine: field(plan.grid, 3000) };
}
function referencePixel(base: GridField, fine: GridField, mask: CoverageMask, patch: RasterPatch, layer: LayerId, x: number, y: number) {
  let r = 0, g = 0, b = 0, alpha = 0;
  for (const [dx, dy] of QUAD_OFFSETS) {
    const point = mercatorPoint(tile.z, tile.x, tile.y, x + 0.25 + dx * 0.5, y + 0.25 + dy * 0.5);
    if (!isCovered(mask, point.lat, point.lon)) continue;
    const selected = refinementCandidate([patch], layer, point.lat, point.lon) && isCovered(patch.mask, point.lat, point.lon);
    const gridMask = selected ? patch.mask : mask, field = selected ? fine : base;
    const sample = sampleGrid(gridMask.grid, field, point.lat, point.lon, layer, gridMask), color = paletteColor(layer, sample.value, sample.status);
    if (!color) continue;
    r += parseInt(color.slice(1, 3), 16); g += parseInt(color.slice(3, 5), 16); b += parseInt(color.slice(5, 7), 16); alpha++;
  }
  return alpha ? [Math.round(r / alpha), Math.round(g / alpha), Math.round(b / alpha), Math.round(alpha * 255 / 4)] : [0, 0, 0, 0];
}
const pixel = (bytes: Uint8Array, x: number, y: number) => [...bytes.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)];

it('composes exact polygon/holes/mask ownership before coloring and never falls back on missing or no-lift values', () => {
  const { mask, patch, base, fine } = fixture(), renderer = createRenderer(mask, { patches: [patch], rasterWorkers: 0 });
  // The patch mask also excludes an interior stripe independent of its polygon.
  for (let row = 0; row < patch.mask.grid.height; row++) for (let col = 0; col < 20; col++) setBit(patch.mask.output, row * patch.mask.grid.width + col, false);
  for (const status of [0, STATUS_NO_LIFT, STATUS_UNAVAILABLE]) {
    fine.flags.fill(status);
    const result = renderer.renderTileRgba(base, layer, tile.z, tile.x, tile.y, { [patch.id]: fine });
    for (const y of [10, 60, 100, 140, 180, 220, 250]) for (const x of [5, 35, 60, 100, 125, 160, 200, 250]) {
      expect(pixel(result, x, y)).toEqual(referencePixel(base, fine, mask, patch, layer, x, y));
    }
  }
  expect(renderer.metrics().geometryHits).toBe(2);
  expect(renderer.metrics().geometryMisses).toBe(1);
  const msl = renderer.renderTileRgba(base, 'usable-lift-msl', tile.z, tile.x, tile.y);
  expect(Buffer.from(msl).equals(renderTileRgba(base, mask, 'usable-lift-msl', tile.z, tile.x, tile.y))).toBe(true);
  expect(() => renderer.renderTileRgba(base, layer, tile.z, tile.x, tile.y)).toThrow('patch field');
  expect(() => renderer.renderTileRgba(base, layer, tile.z, tile.x, tile.y, { extra: fine })).toThrow('patch field');
});

it('keeps refinement inside base coverage and makes unavailable fine cells transparent over valid coarse cells', () => {
  const { mask, patch, base, fine } = fixture();
  mask.output.fill(0);
  const renderer = createRenderer(mask, { patches: [patch], rasterWorkers: 0 });
  const result = renderer.renderTileRgba(base, layer, tile.z, tile.x, tile.y, { [patch.id]: fine });
  expect(result.every(byte => byte === 0)).toBe(true);
});

it('prepares only actual ownership when nested polygon bounds cover the same tile', () => {
  const { mask, base } = fixture();
  const rectangle = (w: number, s: number, e: number, n: number) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  const plans = planRefinements({ type: 'FeatureCollection', features: [
    { type: 'Feature', id: 'zone-001', properties: {}, geometry: { type: 'Polygon', coordinates: [rectangle(10, 35, 18, 43), rectangle(10.1, 35.1, 17.9, 42.9)] } },
    { type: 'Feature', id: 'zone-002', properties: {}, geometry: { type: 'Polygon', coordinates: [rectangle(11, 36, 17, 42)] } }
  ] }, { sourceGrid: mask.grid, bounds: [5, 26, 24, 45], haloCells: 1 });
  const patches: RasterPatch[] = plans.map(plan => ({ id: plan.id, geometry: plan.geometry, descriptors: { bounds: plan.bounds }, layers: [layer], mask: { ...maskFor(plan.grid), bounds: plan.bounds } }));
  const fields = Object.fromEntries(patches.map((patch, i) => [patch.id, { values: new Float32Array(patch.mask.grid.width * patch.mask.grid.height).fill(i ? 3000 : 4000), flags: new Uint8Array(patch.mask.grid.width * patch.mask.grid.height) }]));
  const nested = createRenderer(mask, { patches, rasterWorkers: 0 });
  const actual = nested.renderTileRgba(base, layer, tile.z, tile.x, tile.y, fields);
  const inner = createRenderer(mask, { patches: [patches[1]], rasterWorkers: 0 });
  const expected = inner.renderTileRgba(base, layer, tile.z, tile.x, tile.y, { [patches[1].id]: fields[patches[1].id] });
  expect(Buffer.from(actual).equals(expected)).toBe(true);
  expect(nested.metrics().geometryBytes).toBe(inner.metrics().geometryBytes);
  // A tile lying only in the outer polygon's hole retains the original base-only geometry.
  const outer = createRenderer(mask, { patches: [patches[0]], rasterWorkers: 0 });
  const outsideFine = outer.renderTileRgba(base, layer, tile.z, tile.x, tile.y, { [patches[0].id]: fields[patches[0].id] });
  const coarse = createRenderer(mask, { rasterWorkers: 0 });
  expect(Buffer.from(outsideFine).equals(coarse.renderTileRgba(base, layer, tile.z, tile.x, tile.y))).toBe(true);
  expect(outer.metrics().geometryBytes).toBe(coarse.metrics().geometryBytes);
});

it('shares fine arrays with workers within the existing byte budget and preserves inline pixels', async () => {
  const { mask, patch, base, fine } = fixture(), fields = { [patch.id]: fine };
  const inline = createRenderer(mask, { patches: [patch], rasterWorkers: 0 }).renderTileRgba(base, layer, tile.z, tile.x, tile.y, fields);
  const pool = await createRasterPool(mask, [{ field: base, layer, patches: fields }], { patches: [patch], workers: 1, geometryCacheBytes: 24 * 1024 * 1024, maxPending: 1 });
  try {
    const result = await pool.render(0, 0, tile.z, tile.x, tile.y);
    expect(Buffer.from(result.rgba).equals(inline)).toBe(true);
    const expectedBytes = [mask, patch.mask].reduce((n, mask) => n + mask.output.byteLength + mask.halo.byteLength + mask.tiles.byteLength, 0)
      + [base, fine].reduce((n, field) => n + field.values.byteLength + field.flags.byteLength, 0);
    expect(pool.sharedInputBytes).toBe(expectedBytes);
  } finally { await pool.close(); }
});

it('writes one composite PMTiles archive with the same inline and worker pixels', async () => {
  const { mask, patch, base, fine } = fixture();
  const out = await mkdtemp(join(tmpdir(), 'av-refinement-raster-')); temporary.push(out);
  const expected = createRenderer(mask, { patches: [patch], rasterWorkers: 0 }).renderTileRgba(base, layer, tile.z, tile.x, tile.y, { [patch.id]: fine });
  for (const rasterWorkers of [0, 1]) {
    const path = join(out, `frame-${rasterWorkers}.pmtiles`);
    await createRenderer(mask, { patches: [patch], rasterWorkers }).renderArchives([{ path, field: base, layer, patches: { [patch.id]: fine } }]);
    const bytes = await readFile(path);
    const archive = new PMTiles({ getKey: () => path, async getBytes(offset, length) { const result = bytes.subarray(offset, offset + length); return { data: result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) }; } });
    const image = await archive.getZxy(tile.z, tile.x, tile.y);
    expect(image).toBeDefined();
    expect(Buffer.from((await decodeWebp(new Uint8Array(image!.data))).data).equals(expected)).toBe(true);
  }
}, 30_000);
