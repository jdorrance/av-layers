import { expect, it } from 'vitest';
import { parseWindFrame, WIND_FRAME_LIMIT, WIND_FRAME_MAX_PAGES } from './wind-data.ts';

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
