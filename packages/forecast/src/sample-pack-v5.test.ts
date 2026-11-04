import { expect, it } from 'vitest';
import { CELL_BYTES, MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_VALUES, type RegularLatLonGrid } from '@av/contracts';
import { planSample, type SamplePlan } from './sampler.js';
import { packedCellsFromRange, planShardedPackedSample, prepareShardedSamplePackLayout, SAMPLE_SHARD_TARGET_BYTES } from './sample-pack.js';

const grid = (width: number, height: number, wrapLongitude: boolean): RegularLatLonGrid => ({
  kind: 'regular-latlon', width, height, wrapLongitude, earthRadiusM: 6371229, lon0: 0, lat0: height - 1, dx: 1, dy: -1
});

it('handles one-column longitude wrap and exact shard limits', () => {
  const g = grid(1, 1, true);
  const layout = prepareShardedSamplePackLayout(g, Uint32Array.of(0), 1, 10);
  expect(layout.block(0)).toMatchObject({ width: 2, height: 1, byteOffset: 0, byteLength: 10 });
  expect(layout.shards).toEqual([{ firstBlock: 0, blockCount: 1, byteLength: 10 }]);
  const sample = planSample(g, 0, 0.5)!;
  const plan = planShardedPackedSample(layout, sample, [0]);
  expect(plan.contributorRanks).toEqual([0, 0]);
  expect(plan.byteRange).toEqual({ offset: 0, length: CELL_BYTES });
  expect(() => prepareShardedSamplePackLayout(g, Uint32Array.of(0), 1, 9)).toThrow('Block exceeds');
});

it.each([false, true])('packs and reads all block edges, final partial blocks and wrap=%s', wrap => {
  const g = grid(33, 19, wrap), channels = 3;
  const ids = Uint32Array.of(0, 1, 2, 3, 4, 5);
  const layout = prepareShardedSamplePackLayout(g, ids, channels, 4400);
  ids.fill(0);
  expect(layout.blockCount).toBe(6);
  expect(layout.indexBytes).toBe(48);
  expect(layout.shards.length).toBeGreaterThan(1);
  expect(layout.shards.every(shard => shard.byteLength <= 4400)).toBe(true);
  expect(layout.shards.reduce((sum, shard) => sum + shard.byteLength, 0)).toBe(layout.byteLength);
  expect(layout.block(5)).toMatchObject({ slot: 5, row: 16, column: 32, width: wrap ? 2 : 1, height: 3 });
  const bytes = layout.shards.map(shard => new Uint8Array(shard.byteLength));
  for (let i = 0; i < layout.blockCount; i++) {
    const block = layout.block(i), view = new DataView(bytes[block.shard].buffer);
    expect(block.byteOffset + block.byteLength).toBeLessThanOrEqual(layout.shards[block.shard].byteLength);
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) for (let channel = 0; channel < channels; channel++) {
      const index = (block.row + y) * g.width + (block.column + x) % g.width;
      const offset = block.byteOffset + ((y * block.width + x) * channels + channel) * CELL_BYTES;
      view.setFloat32(offset, index + channel / 4, true);
      view.setUint8(offset + 4, (index + channel) % 256);
    }
  }
  for (const y of [0, 0.5, 15.5, 16, 17.5, 18]) for (const x of [0, 0.5, 15.5, 16, 31.5, 32, ...(wrap ? [32.5] : [])]) {
    const sample = planSample(g, g.lat0 - y, x)!;
    const plan = planShardedPackedSample(layout, sample, [2, 0]);
    const { offset, length } = plan.byteRange;
    expect(offset + length).toBeLessThanOrEqual(layout.shards[plan.shard].byteLength);
    for (const channel of plan.channels) {
      const actual = packedCellsFromRange(plan, bytes[plan.shard].subarray(offset, offset + length), channel);
      expect(actual).toEqual(sample.contributors.map(c => ({ value: c.index + channel / 4, flags: (c.index + channel) % 256 })));
    }
  }
});

it('uses first positive contributor rather than nearest coverage cell, including wrap', () => {
  const g = grid(32, 17, true), layout = prepareShardedSamplePackLayout(g, Uint32Array.of(0, 1, 2, 3), 2, 3000);
  const boundary = planSample(g, 0.25, 15.75)!;
  const plan = planShardedPackedSample(layout, boundary, [1]);
  expect(layout.blockFor(boundary.contributors[0].index)!.slot).toBe(0);
  expect(layout.blockFor(boundary.contributors[3].index)!.slot).toBe(3);
  expect(plan.shard).toBe(layout.block(0).shard);
  const wrapped = planShardedPackedSample(layout, planSample(g, 15.5, 31.5)!, [0, 1]);
  expect(wrapped.shard).toBe(layout.block(1).shard);
  expect(wrapped.contributorRanks[1] - wrapped.contributorRanks[0]).toBe(1);
});

it('indexes sparse blocks without dense fine-grid expansion', () => {
  const width = 14400, height = 7201, columns = Math.ceil(width / 16);
  const last = (Math.ceil(height / 16) - 1) * columns + columns - 1;
  const layout = prepareShardedSamplePackLayout({ width, height, wrapLongitude: true }, Uint32Array.of(0, columns + 4, last), 48);
  expect(layout.indexBytes).toBe(24);
  expect(layout.blockFor(0)?.slot).toBe(0);
  expect(layout.blockFor(16)).toBeNull();
  expect(layout.blockFor((height - 1) * width + width - 1)).toMatchObject({ slot: last, width: 17, height: 1 });
  expect(prepareShardedSamplePackLayout({ width, height, wrapLongitude: false }, new Uint32Array(), 1).shards).toEqual([]);
});

it('keeps the maximum channel request within one shard and the serving range budget', () => {
  const g = grid(33, 33, false), channels = Array.from({ length: MAX_SAMPLE_VALUES }, (_, i) => i);
  const layout = prepareShardedSamplePackLayout(g, Uint32Array.of(0), MAX_SAMPLE_VALUES);
  const plan = planShardedPackedSample(layout, planSample(g, 16.5, 15.5)!, channels);
  expect(plan.byteRange.length).toBe(19 * MAX_SAMPLE_VALUES * CELL_BYTES);
  expect(plan.byteRange.length).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
  expect(plan.byteRange.offset + plan.byteRange.length).toBeLessThanOrEqual(layout.shards[plan.shard].byteLength);
  expect(layout.shards[0].byteLength).toBe(17 * 17 * MAX_SAMPLE_VALUES * CELL_BYTES);
});

it('splits whole blocks at the default 64 MiB boundary', () => {
  const layout = prepareShardedSamplePackLayout(grid(3200, 17, false), Uint32Array.from({ length: 200 }, (_, i) => i), MAX_SAMPLE_VALUES);
  expect(layout.shards).toHaveLength(2);
  expect(layout.shards[0].byteLength).toBe(181 * 17 * 17 * MAX_SAMPLE_VALUES * CELL_BYTES);
  expect(layout.shards[0].byteLength + layout.block(181).byteLength).toBeGreaterThan(SAMPLE_SHARD_TARGET_BYTES);
  expect(layout.block(180).shard).toBe(0);
  expect(layout.block(181)).toMatchObject({ shard: 1, byteOffset: 0 });
  expect(layout.shards.every(shard => shard.byteLength <= SAMPLE_SHARD_TARGET_BYTES)).toBe(true);
});

it('rejects invalid dimensions, directory, target, channels and contributors', () => {
  const g = grid(33, 17, false), ids = Uint32Array.of(0, 1), sample = planSample(g, 16, 0)!;
  const prepare = (blocks = ids, channels = 1, target = SAMPLE_SHARD_TARGET_BYTES) => prepareShardedSamplePackLayout(g, blocks, channels, target);
  for (const dims of [{ width: 0, height: 1 }, { width: 65536, height: 65536 }, { width: 1.5, height: 1 }]) {
    expect(() => prepareShardedSamplePackLayout({ ...dims, wrapLongitude: false }, ids, 1)).toThrow('grid');
  }
  for (const blocks of [Uint32Array.of(0, 0), Uint32Array.of(1, 0), Uint32Array.of(6)]) expect(() => prepare(blocks)).toThrow('order');
  for (const channels of [0, -1, 1.5, MAX_SAMPLE_VALUES + 1]) expect(() => prepare(ids, channels)).toThrow('channel count');
  for (const target of [0, 1.5, SAMPLE_SHARD_TARGET_BYTES + 1]) expect(() => prepare(ids, 1, target)).toThrow('target');
  expect(() => prepare(ids, 1, 1444)).toThrow('Block exceeds');
  const layout = prepare();
  expect(() => layout.block(-1)).toThrow('out of range');
  expect(() => layout.blockFor(g.width * g.height)).toThrow('out of range');
  for (const channels of [[], [-1], [1], [0, 0]]) expect(() => planShardedPackedSample(layout, sample, channels)).toThrow('channels');
  expect(() => planShardedPackedSample(layout, { ...sample, contributors: [] }, [0])).toThrow('count');
  expect(() => planShardedPackedSample(layout, { ...sample, contributors: Array(5).fill(sample.contributors[0]) }, [0])).toThrow('count');
  for (const change of [{ weight: 0 }, { weight: NaN }, { index: 1 }, { column: -1 }, { row: 17 }]) {
    const bad: SamplePlan = { ...sample, contributors: [{ ...sample.contributors[0], ...change }] };
    expect(() => planShardedPackedSample(layout, bad, [0])).toThrow('contributor');
  }
  const distant: SamplePlan = { ...sample, contributors: [...sample.contributors, { index: 2, row: 0, column: 2, weight: 0.5 }] };
  expect(() => planShardedPackedSample(layout, distant, [0])).toThrow('neighborhood');
  const absent = prepare(Uint32Array.of(1));
  expect(() => planShardedPackedSample(absent, sample, [0])).toThrow('owner block');
});
