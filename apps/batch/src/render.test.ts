import { mkdtemp, open, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PMTiles } from 'pmtiles';
import { expectedTiles, paletteColor, setBit, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID, type CoverageMask, type Grid, type LayerId } from '@av/contracts';
import { QUAD_OFFSETS, sampleGrid, type GridField } from '@av/forecast';
import { createRenderer, mercatorPoint, renderArchive, renderTile, renderTileRgba } from './render.js';
import { validateArchive } from './validate.js';
import { decodeWebp } from './webp.js';
import * as codec from './webp.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function maskFor(grid: Grid, maxZoom: number): CoverageMask {
  return { grid, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: new Uint8Array(Math.ceil(((4 ** (maxZoom + 1) - 1) / 3) / 8)), maxZoom };
}

function pixel(image: { data: Uint8Array }, x: number, y: number): number[] { return [...image.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)]; }

function expectRgbaEqual(actual: Uint8Array, expected: Uint8Array, context: string): void {
  expect(Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength).equals(expected), `${context}: complete RGBA equality`).toBe(true);
}

async function reader(path: string): Promise<{ archive: PMTiles; close: () => Promise<void> }> {
  const file = await open(path, 'r');
  return { archive: new PMTiles({ getKey: () => path, async getBytes(offset, length) { const bytes = Buffer.alloc(length), result = await file.read(bytes, 0, length, offset); return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + result.bytesRead) }; } }), close: () => file.close() };
}

function referenceTileRgba(field: GridField, mask: CoverageMask, layer: LayerId, z: number, x: number, y: number): Uint8Array {
  const data = new Uint8Array(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) {
    const px = i & 255, py = i >> 8;
    let r = 0, g = 0, b = 0, alpha = 0;
    for (const [dx, dy] of QUAD_OFFSETS) {
      const pt = mercatorPoint(z, x, y, px + 0.25 + dx * 0.5, py + 0.25 + dy * 0.5);
      const sample = sampleGrid(mask.grid, field, pt.lat, pt.lon, layer, mask);
      const hex = paletteColor(layer, sample.status === STATUS_NO_LIFT ? 0 : sample.value, sample.status);
      if (!hex) continue;
      const opacity = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) : 255;
      r += parseInt(hex.slice(1, 3), 16) * opacity;
      g += parseInt(hex.slice(3, 5), 16) * opacity;
      b += parseInt(hex.slice(5, 7), 16) * opacity;
      alpha += opacity;
    }
    if (alpha) {
      data.set([Math.round(r / alpha), Math.round(g / alpha), Math.round(b / alpha), Math.round(alpha / 4)], i * 4);
    }
  }
  return data;
}

describe('rendered WebP and PMTiles fixtures', () => {
  it('compiles eight-digit colors and weights different alpha values before unpremultiplication', async () => {
    vi.resetModules();
    vi.doMock('@av/contracts', async importOriginal => {
      const actual = await importOriginal<typeof import('@av/contracts')>();
      return { ...actual, PALETTES: { ...actual.PALETTES, rain: { ...actual.PALETTES.rain, colors: ['#ff000080', '#0000ff40'] } } };
    });
    try {
      const { renderTile: renderPartial } = await import('./render.js');
      const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
      const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
      for (let i = 0; i < 4; i++) setBit(mask.output, i);
      const field: GridField = { values: new Float32Array([0.2, 1, 0.2, 1]), flags: new Uint8Array(4) };
      expect(pixel(await decodeWebp(await renderPartial(field, mask, 'precip-rate', 5, 16, 16)), 30, 30)).toEqual([170, 0, 85, 96]);
    } finally { vi.doUnmock('@av/contracts'); vi.resetModules(); }
  });

  it('does not replace nonzero hidden RGB with the shared transparent payload', async () => {
    vi.resetModules();
    vi.doMock('@av/contracts', async importOriginal => {
      const actual = await importOriginal<typeof import('@av/contracts')>();
      return { ...actual, PALETTES: { ...actual.PALETTES, rain: { ...actual.PALETTES.rain, colors: ['#ff000001'] } } };
    });
    try {
      const { createRenderer: createPartial } = await import('./render.js');
      const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
      const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
      setBit(mask.output, 0);
      const field = { values: new Float32Array(4).fill(1), flags: new Uint8Array(4) }, renderer = createPartial(mask);
      const image = await decodeWebp(await renderer.renderTile(field, 'precip-rate', 5, 16, 16));
      expect(pixel(image, 30, 30)).toEqual([255, 0, 0, 0]);
      field.values.fill(0);
      const blank = await decodeWebp(await renderer.renderTile(field, 'precip-rate', 5, 16, 16));
      expect(pixel(blank, 30, 30)).toEqual([0, 0, 0, 0]);
      expect(renderer.metrics().blankTiles).toBe(1);
    } finally { vi.doUnmock('@av/contracts'); vi.resetModules(); }
  });

  it('renders no-lift transparent independently of the stored MSL terrain value', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (let i = 0; i < 4; i++) setBit(mask.output, i);
    const field: GridField = { values: new Float32Array(4).fill(5500), flags: new Uint8Array(4).fill(STATUS_NO_LIFT) };
    expect(sampleGrid(grid, field, a.lat, a.lon, 'usable-lift-msl', mask)).toMatchObject({ value: null, status: STATUS_NO_LIFT });
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-msl', 5, 16, 16)), 30, 30)).toEqual([0, 0, 0, 0]);
    field.values.fill(0);
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-agl', 5, 16, 16)), 30, 30)).toEqual([0, 0, 0, 0]);
  });

  it('premultiplies valid and no-lift quarter-pixels without a dark fringe', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (let i = 0; i < 4; i++) setBit(mask.output, i);
    const field: GridField = { values: new Float32Array([300, 0, 300, 0]), flags: new Uint8Array([STATUS_VALID, STATUS_NO_LIFT, STATUS_VALID, STATUS_NO_LIFT]) };
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-agl', 5, 16, 16)), 30, 30)).toEqual([185, 59, 136, 128]);
  });

  it('averages mixed quarter-point colors in premultiplied alpha without per-pixel parsing', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (const i of [0, 1, 2]) setBit(mask.output, i);
    setBit(mask.halo, 3);
    const field: GridField = { values: new Float32Array([0.2, 1, 2, 5]), flags: new Uint8Array(4) };
    const parse = vi.spyOn(globalThis, 'parseInt');
    try {
      const image = await decodeWebp(await renderTile(field, mask, 'precip-rate', 5, 16, 16));
      expect(pixel(image, 30, 30)).toEqual([95, 172, 184, 191]);
      expect(parse).not.toHaveBeenCalled();
    } finally { parse.mockRestore(); }
  });

  it('maps interpolated scalar values to bins before averaging quarter-point colors', async () => {
    const a = mercatorPoint(5, 16, 16, 40, 40), b = mercatorPoint(5, 16, 16, 41, 41);
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (let i = 0; i < 4; i++) setBit(mask.output, i);
    const field: GridField = { values: new Float32Array([0, 4, 0, 4]), flags: new Uint8Array(4) };
    for (const py of [40.25, 40.75]) {
      const p = mercatorPoint(5, 16, 16, 40.25, py), q = mercatorPoint(5, 16, 16, 40.75, py);
      expect(sampleGrid(grid, field, p.lat, p.lon, 'precip-rate', mask).value).toBeCloseTo(1);
      expect(sampleGrid(grid, field, q.lat, q.lon, 'precip-rate', mask).value).toBeCloseTo(3);
    }
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'precip-rate', 5, 16, 16)), 40, 40)).toEqual([50, 143, 149, 255]);
  });

  it('separates center scalar coverage from quarter-pixel premultiplied color', async () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 3, height: 3, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false }, mask = maskFor(grid, 5);
    const field: GridField = { values: new Float32Array(9).fill(2), flags: new Uint8Array(9).fill(STATUS_OUTSIDE) };
    for (let i = 0; i < 9; i++) if (i % 3 < 2) { setBit(mask.output, i); field.flags[i] = STATUS_VALID; }
    const center = mercatorPoint(5, 16, 16, 11.5, 0.5), inside = mercatorPoint(5, 16, 16, 11.25, 0.25), outside = mercatorPoint(5, 16, 16, 11.75, 0.25);
    expect(sampleGrid(grid, field, center.lat, center.lon, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
    expect(sampleGrid(grid, field, inside.lat, inside.lon, 'precip-rate', mask).value).toBeCloseTo(2);
    expect(sampleGrid(grid, field, outside.lat, outside.lon, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'precip-rate', 5, 16, 16)), 11, 0)).toEqual([54, 166, 87, 128]);
  });

  it('preserves XYZ north/south orientation and rejects an absent expected tile', async () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 1);
    for (let i = 0; i < 12; i++) setBit(mask.output, i);
    for (const bit of [0, 1, 3]) setBit(mask.tiles, bit);
    const field: GridField = { values: new Float32Array([1,1,1,1, 1,1,1,1, 20,20,20,20]), flags: new Uint8Array(12) };
    const dir = await mkdtemp(join(tmpdir(), 'av-render-')); temporary.push(dir);
    const path = join(dir, 'fixture.pmtiles');
    await renderArchive(path, field, mask, 'precip-rate');
    await validateArchive(path, mask);
    expect(expectedTiles(mask, 1)).toEqual([{ z: 1, x: 0, y: 0 }, { z: 1, x: 0, y: 1 }]);
    const source = await reader(path);
    try {
      const north = await decodeWebp(new Uint8Array((await source.archive.getZxy(1, 0, 0))!.data));
      const south = await decodeWebp(new Uint8Array((await source.archive.getZxy(1, 0, 1))!.data));
      expect(pixel(north, 128, 200)).toEqual([45, 120, 210, 255]);
      expect(pixel(south, 128, 55)).not.toEqual(pixel(north, 128, 200));
      expect(await source.archive.getZxy(1, 1, 1)).toBeUndefined();
    } finally { await source.close(); }
    setBit(mask.tiles, 4);
    await expect(validateArchive(path, mask)).rejects.toThrow('Missing or invalid active tile');
  }, 30000);

  it('retains every transparent no-lift tile address at each zoom', async () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 2);
    for (let i = 0; i < 12; i++) setBit(mask.output, i);
    for (let bit = 0; bit < 21; bit++) setBit(mask.tiles, bit);
    const field: GridField = { values: new Float32Array(12), flags: new Uint8Array(12).fill(STATUS_NO_LIFT) };
    const dir = await mkdtemp(join(tmpdir(), 'av-render-')); temporary.push(dir);
    const path = join(dir, 'blank.pmtiles');
    await renderArchive(path, field, mask, 'usable-lift-agl');
    await validateArchive(path, mask);
    const source = await reader(path);
    try {
      const header = await source.archive.getHeader();
      expect(header.numAddressedTiles).toBe(21); expect(header.numTileContents).toBe(21); expect(header.maxZoom).toBe(2);
      const allTiles = Array.from({ length: mask.maxZoom + 1 }, (_, z) => expectedTiles(mask, z)).flat();
      for (const tile of allTiles) {
        const data = await source.archive.getZxy(tile.z, tile.x, tile.y);
        expect(data).toBeDefined();
        expect((await decodeWebp(new Uint8Array(data!.data))).data.every(byte => byte === 0)).toBe(true);
      }
    }
    finally { await source.close(); }
  }, 30000);
});

describe('build-owned prepared renderer', () => {
  it('groups layers under one queue and preserves every address and decoded pixel', async () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 1);
    for (let i = 0; i < 12; i++) setBit(mask.output, i);
    for (let i = 0; i < 5; i++) setBit(mask.tiles, i);
    const dir = await mkdtemp(join(tmpdir(), 'av-grouped-')); temporary.push(dir);
    const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
    const targets = layers.map((layer, i) => ({ layer, path: join(dir, `${layer}.pmtiles`), field: { values: Float32Array.from({ length: 12 }, (_, cell) => (cell + 1) * (i ? 0.5 : 100)), flags: Uint8Array.from({ length: 12 }, (_, cell) => cell === 4 && i < 2 ? STATUS_NO_LIFT : STATUS_VALID) } }));
    const renderer = createRenderer(mask, { encodeConcurrency: 2, geometryCacheBytes: 60_000, rasterWorkers: 0 });
    await renderer.renderArchives(targets);
    expect(renderer.metrics()).toMatchObject({ geometryMisses: 5, geometryHits: 10, peakPendingTiles: 2, peakPendingTileBytes: 2 * (256 * 256 * 4 + 1024 * 1024) });
    for (const target of targets) {
      const source = await reader(target.path);
      try {
        expect((await source.archive.getHeader()).numAddressedTiles).toBe(5);
        for (const tile of [...expectedTiles(mask, 0), ...expectedTiles(mask, 1)]) {
          const encoded = await source.archive.getZxy(tile.z, tile.x, tile.y);
          expect(encoded).toBeDefined();
          expectRgbaEqual((await decodeWebp(new Uint8Array(encoded!.data))).data, renderTileRgba(target.field, mask, target.layer, tile.z, tile.x, tile.y), `${target.layer}/${tile.z}/${tile.x}/${tile.y}`);
        }
      } finally { await source.close(); }
    }
  });

  it('matches sampleGrid + paletteColor and reuses only bounded geometry across fields', () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 1);
    for (let i = 0; i < 12; i++) if (i !== 5) setBit(mask.output, i);
    const geometryBudget = 2 * (57344 + 12 * Uint32Array.BYTES_PER_ELEMENT);
    const renderer = createRenderer(mask, { geometryCacheBytes: geometryBudget });
    const field = { values: Float32Array.from([0.1, 0.5, 1, 2, 300, 600, 1500, 2750, 0, -10, 50, 100]), flags: Uint8Array.from([0, 1, 0, 2, 0, 0, 1, 0, 3, 0, 0, 0]) };
    for (const layer of ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'] as const) {
      if (layer === 'precip-rate') field.flags.fill(0);
      const expected = referenceTileRgba(field, mask, layer, 1, 0, 0);
      expectRgbaEqual(renderer.renderTileRgba(field, layer, 1, 0, 0), expected, `prepared ${layer}/1/0/0`);
      expectRgbaEqual(renderTileRgba(field, mask, layer, 1, 0, 0), expected, `uncached ${layer}/1/0/0`);
    }
    expect(renderer.metrics()).toMatchObject({ geometryHits: 2, geometryMisses: 1, geometryBytes: 57368 });
    renderer.renderTileRgba(field, 'precip-rate', 1, 0, 1);
    renderer.renderTileRgba(field, 'precip-rate', 1, 1, 1);
    expect(renderer.metrics().geometryBytes).toBeGreaterThan(57368);
    expect(renderer.metrics().geometryBytes).toBeLessThanOrEqual(geometryBudget);
    expect(renderer.metrics().peakGeometryBytes).toBeLessThanOrEqual(geometryBudget);
    renderer.renderTileRgba(field, 'precip-rate', 1, 0, 0);
    expect(renderer.metrics().geometryMisses).toBe(4);
    const uncached = createRenderer(mask, { geometryCacheBytes: 0 });
    uncached.renderTileRgba(field, 'precip-rate', 1, 0, 0);
    expect(uncached.metrics().geometryBytes).toBe(0);
  });

  it('shares an exactly blank payload and keeps the archive writer bounded', async () => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 2);
    for (let i = 0; i < 12; i++) setBit(mask.output, i);
    for (let i = 0; i < 21; i++) setBit(mask.tiles, i);
    const field = { values: new Float32Array(12), flags: new Uint8Array(12).fill(STATUS_NO_LIFT) };
    const renderer = createRenderer(mask, { encodeConcurrency: 2, rasterWorkers: 0 });
    const spy = vi.spyOn(codec, 'encodeWebp');
    const dir = await mkdtemp(join(tmpdir(), 'av-render-')); temporary.push(dir);
    try {
      const a = await renderer.renderTile(field, 'usable-lift-agl', 0, 0, 0);
      const b = await renderer.renderTile(field, 'usable-lift-msl', 1, 0, 0);
      expect(a).toBe(b);
      await renderer.renderArchive(join(dir, 'blank.pmtiles'), field, 'usable-lift-agl');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(renderer.metrics()).toMatchObject({ peakPendingTiles: 2, blankTiles: 23 });
      await validateArchive(join(dir, 'blank.pmtiles'), mask);
    } finally { spy.mockRestore(); }
  });

  it.each([0, 2])('drains already-started encodes before rejecting a failed archive (%i raster workers)', async rasterWorkers => {
    const grid = { kind: 'regular-latlon' as const, earthRadiusM: 6371229, width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 1);
    for (let i = 0; i < 12; i++) setBit(mask.output, i);
    for (let i = 0; i < 5; i++) setBit(mask.tiles, i);
    const field = { values: new Float32Array(12).fill(2), flags: new Uint8Array(12) };
    const controller = new AbortController(), renderer = createRenderer(mask, { encodeConcurrency: 2, rasterWorkers, signal: controller.signal });
    const original = codec.encodeWebp;
    let fail!: () => void, finish!: () => void, bothStarted!: () => void, started = 0, drained = false, settled = false;
    const failure = new Promise<void>(resolve => { fail = resolve; }), completion = new Promise<void>(resolve => { finish = resolve; }), encodesStarted = new Promise<void>(resolve => { bothStarted = resolve; });
    const startedEncode = () => { if (++started === 2) bothStarted(); };
    const spy = vi.spyOn(codec, 'encodeWebp')
      .mockImplementationOnce(async () => { startedEncode(); await failure; throw new Error('encode failed'); })
      .mockImplementationOnce(async (...args) => { startedEncode(); await completion; const result = await original(...args); drained = true; return result; });
    const dir = await mkdtemp(join(tmpdir(), 'av-render-')); temporary.push(dir);
    const work = renderer.renderArchive(join(dir, 'failed.pmtiles'), field, 'precip-rate').then(() => { settled = true; }, error => { settled = true; return error; });
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        encodesStarted,
        work.then(error => { throw new Error('Archive settled before both encodes started', { cause: error }); }),
        new Promise<never>((_, reject) => { startupTimer = setTimeout(() => reject(new Error('Both encodes did not start within 10 seconds')), 10_000); })
      ]);
      clearTimeout(startupTimer);
      expect(spy).toHaveBeenCalledTimes(2);
      fail(); await nextTurn();
      expect(settled).toBe(false); finish();
      expect(await work).toMatchObject({ message: 'encode failed' });
      expect(drained).toBe(true); expect(spy).toHaveBeenCalledTimes(2);
      await expect(stat(join(dir, 'failed.pmtiles'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      clearTimeout(startupTimer); fail(); finish(); controller.abort(new Error('Test cleanup'));
      try { await work; } finally { spy.mockRestore(); }
    }
  });
});
