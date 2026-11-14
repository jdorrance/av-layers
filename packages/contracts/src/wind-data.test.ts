import { expect, it } from 'vitest';
import { assertWindFrameLayout, parseWindFrame, windFrameParts, windLayout, windOverviewLayout, WIND_FRAME_LIMIT, WIND_FRAME_MAX_PAGES, WIND_OVERVIEW_CELL_BYTES, WIND_OVERVIEW_TILE_SIZE, type WindFrame } from './wind-data.ts';

const shard = { sha256: 'a'.repeat(64), bytes: 1, indexSha256: 'b'.repeat(64), count: 1 };
const frame = { version: 3, frame: 'f001', levels: 21, tileSize: 16, fineTileSize: 64,
  wind: Array(9).fill(shard), fine: Array(50).fill(shard) };
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

it('admits the largest current model frame inventory within the shared byte and structure bounds', () => {
  expect(bytes(frame).length).toBeLessThan(WIND_FRAME_LIMIT);
  expect(parseWindFrame(bytes(frame))).toEqual(frame);
});

it('rejects old target codecs and inventory excess before accepting a frame', () => {
  expect(() => parseWindFrame(bytes({ ...frame, version: 2 }))).toThrow();
  expect(() => parseWindFrame(bytes({ ...frame, wind: Array(WIND_FRAME_MAX_PAGES + 1).fill(shard) }))).toThrow();
  expect(() => parseWindFrame(new Uint8Array(WIND_FRAME_LIMIT + 1))).toThrow('byte budget');
});

it('binds full and partial shard pages to both grids before a reader admits ranges', () => {
  const grids = { native: { width: 16 * 513, height: 16 }, fine: { width: 65, height: 65 } };
  const descriptor: WindFrame = { version: 3, frame: 'f001', levels: 3, tileSize: 16, fineTileSize: 64,
    wind: [{ ...shard, count: 512, bytes: 512 * 12300 }, { ...shard, count: 1, bytes: 12300 }],
    fine: [{ ...shard, count: 4, bytes: 4 * 40960 }] };
  expect(() => assertWindFrameLayout(descriptor, grids)).not.toThrow();
  expect(() => assertWindFrameLayout({ ...descriptor, wind: descriptor.wind.slice(0, 1) }, grids)).toThrow('layout mismatch');
  expect(() => assertWindFrameLayout({ ...descriptor, levels: 4 }, grids)).toThrow('shard layout mismatch');
  expect(() => assertWindFrameLayout({ ...descriptor, fine: [{ ...descriptor.fine[0], count: 1 }] }, grids)).toThrow('shard layout mismatch');
  expect(() => assertWindFrameLayout(descriptor, { ...grids, native: { width: 16 * 512, height: 16 } })).toThrow('layout mismatch');
});

it('admits legacy frames and validates every overview page against its stride', () => {
  const grids = { native: { width: 64 * 513, height: 64 }, fine: { width: 65, height: 65 } };
  const shards = (layout: ReturnType<typeof windLayout>) => Array.from({ length: layout.pages }, (_, page) => ({ ...shard,
    count: layout.pageCount(page), bytes: layout.pageCount(page) * layout.chunkBytes }));
  const descriptor: WindFrame = { version: 3, frame: 'f001', levels: 1, tileSize: 16, fineTileSize: 64,
    wind: shards(windLayout(grids.native.width, grids.native.height, 16, 1)), fine: shards(windLayout(65, 65, 64)) };
  expect(() => assertWindFrameLayout(parseWindFrame(bytes(descriptor)), grids)).not.toThrow();
  expect(windFrameParts(descriptor).map(part => part.kind)).toEqual(['wind', 'fine']);
  const overview = [2, 4].map(stride => ({ stride, shards: shards(windOverviewLayout(grids.native, stride)) }));
  expect(overview[0].shards.map(part => part.count)).toEqual([512, 1]);
  expect(overview[0].shards[1].bytes).toBe(WIND_OVERVIEW_TILE_SIZE ** 2 * WIND_OVERVIEW_CELL_BYTES);
  descriptor.overview = overview;
  expect(() => assertWindFrameLayout(parseWindFrame(bytes(descriptor)), grids)).not.toThrow();
  expect(windFrameParts(descriptor).map(part => part.kind)).toEqual(['wind', 'fine', 'overview-2', 'overview-4']);
  expect(() => assertWindFrameLayout({ ...descriptor, overview: [overview[1]] }, grids)).toThrow('stride mismatch');
  expect(() => assertWindFrameLayout({ ...descriptor, overview: [overview[0], overview[0]] }, grids)).toThrow('stride mismatch');
  expect(() => assertWindFrameLayout({ ...descriptor, overview: [{ ...overview[0], shards: overview[0].shards.slice(0, 1) }] }, grids)).toThrow('layout mismatch');
  expect(() => assertWindFrameLayout({ ...descriptor, overview: [{ ...overview[0], shards: [overview[0].shards[0], { ...overview[0].shards[1], bytes: 1 }] }] }, grids)).toThrow('shard layout mismatch');
});
