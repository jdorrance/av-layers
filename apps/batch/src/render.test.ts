import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PMTiles } from 'pmtiles';
import { expectedTiles, setBit, STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_VALID, type CoverageMask, type Grid } from '@av/contracts';
import { sampleGrid, type GridField } from '@av/forecast';
import { mercatorPoint, renderArchive, renderTile } from './render.js';
import { validateArchive } from './validate.js';
import { decodeWebp } from './webp.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

function maskFor(grid: Grid, maxZoom: number): CoverageMask {
  return { grid, output: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), halo: new Uint8Array(Math.ceil(grid.width * grid.height / 8)), tiles: new Uint8Array(Math.ceil(((4 ** (maxZoom + 1) - 1) / 3) / 8)), maxZoom };
}

function pixel(image: { data: Uint8Array }, x: number, y: number): number[] { return [...image.data.subarray((y * 256 + x) * 4, (y * 256 + x) * 4 + 4)]; }

async function reader(path: string): Promise<{ archive: PMTiles; close: () => Promise<void> }> {
  const file = await open(path, 'r');
  return { archive: new PMTiles({ getKey: () => path, async getBytes(offset, length) { const bytes = Buffer.alloc(length), result = await file.read(bytes, 0, length, offset); return { data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + result.bytesRead) }; } }), close: () => file.close() };
}

describe('rendered WebP and PMTiles fixtures', () => {
  it('compiles eight-digit colors and weights different alpha values before unpremultiplication', async () => {
    vi.resetModules();
    vi.doMock('@av/contracts', async importOriginal => {
      const actual = await importOriginal<typeof import('@av/contracts')>();
      return { ...actual, PALETTES: { ...actual.PALETTES, rain: { ...actual.PALETTES.rain, colors: ['#ff000080', '#0000ff40'] } }, paletteColor: (layer: Parameters<typeof actual.paletteColor>[0], value: number | null, status: number) => layer === 'precip-rate' && status === STATUS_VALID && value !== null ? value < 0.5 ? '#ff000080' : '#0000ff40' : actual.paletteColor(layer, value, status) };
    });
    try {
      const { renderTile: renderPartial } = await import('./render.js');
      const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
      const grid = { width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
      for (let i = 0; i < 4; i++) setBit(mask.output, i);
      const field: GridField = { values: new Float32Array([0.2, 1, 0.2, 1]), flags: new Uint8Array(4) };
      expect(pixel(await decodeWebp(await renderPartial(field, mask, 'precip-rate', 5, 16, 16)), 30, 30)).toEqual([170, 0, 85, 96]);
    } finally { vi.doUnmock('@av/contracts'); vi.resetModules(); }
  });

  it('renders no-lift transparent independently of the stored MSL terrain value', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (let i = 0; i < 4; i++) setBit(mask.output, i);
    const field: GridField = { values: new Float32Array(4).fill(5500), flags: new Uint8Array(4).fill(STATUS_NO_LIFT) };
    expect(sampleGrid(grid, field, a.lat, a.lon, 'usable-lift-msl', mask)).toMatchObject({ value: null, status: STATUS_NO_LIFT });
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-msl', 5, 16, 16)), 30, 30)).toEqual([0, 0, 0, 0]);
    field.values.fill(0);
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-agl', 5, 16, 16)), 30, 30)).toEqual([0, 0, 0, 0]);
  });

  it('premultiplies valid and no-lift quarter-pixels without a dark fringe', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
    for (let i = 0; i < 4; i++) setBit(mask.output, i);
    const field: GridField = { values: new Float32Array([300, 0, 300, 0]), flags: new Uint8Array([STATUS_VALID, STATUS_NO_LIFT, STATUS_VALID, STATUS_NO_LIFT]) };
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'usable-lift-agl', 5, 16, 16)), 30, 30)).toEqual([185, 59, 136, 128]);
  });

  it('averages mixed quarter-point colors in premultiplied alpha without per-pixel parsing', async () => {
    const a = mercatorPoint(5, 16, 16, 30.25, 30.25), b = mercatorPoint(5, 16, 16, 30.75, 30.75);
    const grid = { width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
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
    const grid = { width: 2, height: 2, lon0: a.lon, lat0: a.lat, dx: b.lon - a.lon, dy: b.lat - a.lat, wrapLongitude: false }, mask = maskFor(grid, 5);
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
    const grid = { width: 3, height: 3, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false }, mask = maskFor(grid, 5);
    const field: GridField = { values: new Float32Array(9).fill(2), flags: new Uint8Array(9).fill(STATUS_OUTSIDE) };
    for (let row = 0; row < 3; row++) for (let col = 0; col < 2; col++) { setBit(mask.output, row * 3 + col); field.flags[row * 3 + col] = STATUS_VALID; }
    const center = mercatorPoint(5, 16, 16, 11.5, 0.5), inside = mercatorPoint(5, 16, 16, 11.25, 0.25), outside = mercatorPoint(5, 16, 16, 11.75, 0.25);
    expect(sampleGrid(grid, field, center.lat, center.lon, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
    expect(sampleGrid(grid, field, inside.lat, inside.lon, 'precip-rate', mask).value).toBeCloseTo(2);
    expect(sampleGrid(grid, field, outside.lat, outside.lon, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
    expect(pixel(await decodeWebp(await renderTile(field, mask, 'precip-rate', 5, 16, 16)), 11, 0)).toEqual([54, 166, 87, 128]);
  });

  it('preserves XYZ north/south orientation and rejects an absent expected tile', async () => {
    const grid = { width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 1);
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
    const grid = { width: 4, height: 3, lon0: -180, lat0: 60, dx: 90, dy: -60, wrapLongitude: true }, mask = maskFor(grid, 2);
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
      for (let z = 0; z <= mask.maxZoom; z++) for (const tile of expectedTiles(mask, z)) {
        const data = await source.archive.getZxy(z, tile.x, tile.y);
        expect(data).toBeDefined();
        expect((await decodeWebp(new Uint8Array(data!.data))).data.every(byte => byte === 0)).toBe(true);
      }
    }
    finally { await source.close(); }
  }, 30000);
});
