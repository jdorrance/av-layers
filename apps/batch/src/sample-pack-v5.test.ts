import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { CELL_BYTES, SAMPLE_BLOCK_SIZE, STATUS_OUTSIDE, setBit, sparseCoverageFromDense, sparseCoverageLookup, type RegularLatLonGrid } from '@av/contracts';
import { packedCellsFromRange, packedRecordsFromRange, profileRecordBytes, readProfileRecord, validateProfileRecord, writeProfileRecord, planSample, planShardedPackedSample, prepareSamplePackLayout, prepareShardedSamplePackLayout, type GridField } from '@av/forecast';
import { createSamplePackBuilder } from './sample-pack.js';
import { createShardedSamplePackWriter, mergeShardedSamplePacks, samplePackWriterBufferBytes, sampleShardKey } from './sample-pack-v5.js';
import { localPath } from './validate.js';

const grid = (width: number, height: number, wrapLongitude: boolean): RegularLatLonGrid => ({
  kind: 'regular-latlon', width, height, wrapLongitude, earthRadiusM: 6371229, lon0: 0, lat0: height - 1, dx: 1, dy: -1
});

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

it('admits actual scalar/profile scratch allocations and reuses the chunk across writes and finish', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-buffers-'));
  try {
    for (const recordBytes of [CELL_BYTES, profileRecordBytes(24)]) {
      const g = grid(160, 32, true), coverage = coverageFor(g, Array.from({ length: 20 }, (_, index) => index));
      const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, undefined, recordBytes);
      const allocations = vi.spyOn(Buffer, 'allocUnsafe');
      try {
        const writer = createShardedSamplePackWriter(layout, coverage, target(join(root, String(recordBytes))));
        const sizes = allocations.mock.calls.map(([bytes]) => bytes);
        expect(sizes).toHaveLength(2);
        expect(sizes.reduce((sum, bytes) => sum + bytes, 0)).toBe(samplePackWriterBufferBytes(layout));
        const chunkBytes = Math.max(...sizes), record = new Uint8Array(recordBytes), outsideRecord = record.slice();
        outsideRecord[4] = STATUS_OUTSIDE;
        await writer.writeRawChannel(1, () => record, { outsideRecord });
        await writer.writeRawChannel(0, () => record, { outsideRecord });
        await writer.finish();
        expect(allocations.mock.calls.filter(([bytes]) => bytes === chunkBytes)).toHaveLength(1);
      } finally { allocations.mockRestore(); }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

function coverageFor(grid: RegularLatLonGrid, blocks: readonly number[]) {
  const width = grid.width, height = grid.height, columns = Math.ceil(width / SAMPLE_BLOCK_SIZE);
  const cells = width * height, output = new Uint8Array(Math.ceil(cells / 8)), halo = new Uint8Array(output.length);
  for (const slot of blocks) {
    const row = Math.floor(slot / columns) * SAMPLE_BLOCK_SIZE, column = (slot % columns) * SAMPLE_BLOCK_SIZE;
    setBit(output, row * width + column);
  }
  return sparseCoverageFromDense({ width, height, wrapLongitude: grid.wrapLongitude, gridHash: 'a'.repeat(64), output, halo });
}

function denseMasks(grid: RegularLatLonGrid, coverage: ReturnType<typeof coverageFor>) {
  const cells = grid.width * grid.height, output = new Uint8Array(Math.ceil(cells / 8)), halo = new Uint8Array(output.length);
  for (let i = 0; i < cells; i++) {
    const lookup = sparseCoverageLookup(coverage, i % grid.width, Math.floor(i / grid.width));
    if (lookup?.output) setBit(output, i);
    if (lookup?.halo) setBit(halo, i);
  }
  return { output, halo };
}

function denseFields(grid: RegularLatLonGrid, coverage: ReturnType<typeof coverageFor>, channels: number): GridField[] {
  const cells = grid.width * grid.height;
  return Array.from({ length: channels }, (_, channel) => {
    const values = new Float32Array(cells), flags = new Uint8Array(cells).fill(STATUS_OUTSIDE);
    for (let i = 0; i < cells; i++) {
      const row = Math.floor(i / grid.width), column = i % grid.width;
      if (!sparseCoverageLookup(coverage, column, row)) continue;
      values[i] = i + channel * 1000.25;
      flags[i] = (i + channel) % 4;
    }
    return { values, flags };
  });
}

const target = (root: string, surfaceId = 'fine') => ({ root, model: 'gfs', buildId: '20261104T000000Z', surfaceId });

it('round trips multi-channel shards across the 1 MiB channel boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-large-'));
  try {
    const g = { ...grid(512, 512, true), lat0: 80, dx: 360 / 512, dy: -0.3 };
    const output = new Uint8Array(g.width * g.height / 8).fill(255), halo = new Uint8Array(output.length);
    for (let i = 0; i < g.width * g.height; i += 13) output[i >> 3] &= ~(1 << (i & 7));
    const coverage = sparseCoverageFromDense({ width: g.width, height: g.height, wrapLongitude: true, gridHash: 'a'.repeat(64), output, halo });
    const fields = Array.from({ length: 3 }, (_, channel) => ({
      values: Float32Array.from({ length: g.width * g.height }, (_, index) => index * 0.25 + channel * 100.5),
      flags: Uint8Array.from({ length: g.width * g.height }, (_, index) => (index + channel) % 4)
    }));
    const worker = async (first: number, count: number) => {
      const workerRoot = join(root, `worker-${first}`), layout = prepareShardedSamplePackLayout(g, coverage.blockIds, count);
      expect(layout.shards).toHaveLength(1);
      expect(layout.shards[0].byteLength / count).toBeGreaterThan(1024 * 1024);
      const writer = createShardedSamplePackWriter(layout, coverage, target(workerRoot));
      for (let channel = count - 1; channel >= 0; channel--) await writer.writeChannel(channel, fields[first + channel]);
      return { root: workerRoot, channelCount: count, shards: await writer.finish() };
    };
    const probe = await open(join(root, 'probe'), 'wx+'), prototype = Object.getPrototypeOf(probe) as FileHandle;
    const originalRead = prototype.read as (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
    await probe.close();
    const readLengths: number[] = [];
    const spy = vi.spyOn(prototype, 'read').mockImplementation((async function (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) {
      readLengths.push(length);
      return originalRead.call(this, buffer, offset, length, position);
    }) as typeof prototype.read);
    let first: Awaited<ReturnType<typeof worker>>;
    try { first = await worker(0, 2); } finally { spy.mockRestore(); }
    expect(readLengths).toContain(1048575);
    expect(readLengths.every(length => length <= 1048575 && length % CELL_BYTES === 0)).toBe(true);
    const second = await worker(2, 1);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 3);
    const mergedRoot = join(root, 'merged');
    const merged = await mergeShardedSamplePacks(layout, [first, second], target(mergedRoot));
    expect(merged).toHaveLength(1);
    const bytes = await readFile(localPath(mergedRoot, merged[0].key)), expected = Buffer.alloc(bytes.length);
    let rank = 0;
    for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
      const block = layout.block(ordinal);
      for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
        const index = (block.row + y) * g.width + (block.column + x) % g.width;
        const active = (output[index >> 3] & (1 << (index & 7))) !== 0;
        for (let channel = 0; channel < fields.length; channel++) {
          const offset = (rank * fields.length + channel) * CELL_BYTES;
          expected.writeFloatLE(active ? fields[channel].values[index] : 0, offset);
          expected[offset + 4] = active ? fields[channel].flags[index] : STATUS_OUTSIDE;
        }
        rank++;
      }
    }
    expect(rank * CELL_BYTES).toBeGreaterThan(1024 * 1024);
    for (const record of [209714, 209715, 209716]) {
      const offset = record * fields.length * CELL_BYTES;
      expect(bytes.subarray(offset, offset + fields.length * CELL_BYTES)).toEqual(expected.subarray(offset, offset + fields.length * CELL_BYTES));
    }
    expect(bytes.equals(expected)).toBe(true);
    expect(merged[0].sha256).toBe(sha(expected));
    for (const [lat, lon] of [[20, 359.8], [30, 90.2], [-60, 180.5]]) {
      const sample = planSample(g, lat, lon)!;
      const plan = planShardedPackedSample(layout, sample, [2, 0, 1]);
      const range = bytes.subarray(plan.byteRange.offset, plan.byteRange.offset + plan.byteRange.length);
      for (const channel of plan.channels) expect(packedCellsFromRange(plan, range, channel)).toEqual(sample.contributors.map(c => {
        const active = (output[c.index >> 3] & (1 << (c.index & 7))) !== 0;
        return { value: active ? fields[channel].values[c.index] : 0, flags: active ? fields[channel].flags[c.index] : STATUS_OUTSIDE };
      }));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves distinct packed values at nonzero offsets in little-endian layout', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-stride-'));
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 1000);
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    await writer.writeChannel(0, { values: Float32Array.of(1.5, -123.25, 9876.5), flags: Uint8Array.of(1, 2, 3), coverage } as GridField);
    const shards = await writer.finish();
    for (let i = 0; i < 3; i++) {
      const block = layout.block(i), bytes = await readFile(localPath(root, shards[block.shard].key));
      expect(bytes.readFloatLE(block.byteOffset)).toBe([1.5, -123.25, 9876.5][i]);
      expect(bytes[block.byteOffset + 4]).toBe(i + 1);
      expect(shards[block.shard].sha256).toBe(sha(bytes));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('writes surface-namespaced frame-group shard keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-group-'));
  try {
    const g = grid(17, 1, false), coverage = coverageFor(g, [0, 1]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 85);
    const writer = createShardedSamplePackWriter(layout, coverage, { ...target(root), group: 2 });
    await writer.writeChannel(0, { values: Float32Array.of(3, 7), flags: Uint8Array.of(0, 0), coverage } as GridField);
    const shards = await writer.finish();
    expect(shards.map(shard => shard.key)).toEqual(shards.map((_, i) => `builds/gfs/20261104T000000Z/surfaces/fine/samples/src-g2-b${i}.bin`));
    expect(() => sampleShardKey('gfs', 'build', 'fine', 0, -1)).toThrow('frame group');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retains every channel after LRU eviction across more than 32 shards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-evict-'));
  try {
    const g = grid(16 * 35, 1, false), coverage = coverageFor(g, Array.from({ length: 35 }, (_, i) => i));
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 3, 255);
    expect(layout.shards.length).toBeGreaterThan(32);
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    for (const channel of [2, 0, 1]) {
      const values = Float32Array.from({ length: 35 }, (_, i) => (i + 1) * 17.25 + channel * 1000);
      await writer.writeChannel(channel, { values, flags: Uint8Array.from(values, (_, i) => i % 4), coverage } as GridField);
    }
    const largestShard = Math.max(...layout.shards.map(shard => shard.byteLength)), allocations = vi.spyOn(Buffer, 'allocUnsafe');
    let shards: Awaited<ReturnType<typeof writer.finish>>;
    try {
      shards = await writer.finish();
      expect(allocations.mock.calls.filter(([bytes]) => bytes === largestShard)).toHaveLength(1);
    } finally { allocations.mockRestore(); }
    expect(layout.shards.at(-1)!.byteLength).toBeLessThan(largestShard);
    for (let i = 0; i < layout.blockCount; i++) {
      const block = layout.block(i), bytes = await readFile(localPath(root, shards[block.shard].key));
      const expected = Buffer.alloc(layout.shards[block.shard].byteLength);
      expect(bytes.byteLength).toBe(expected.byteLength);
      for (let x = 0; x < block.width; x++) for (let channel = 0; channel < 3; channel++) {
        const active = sparseCoverageLookup(coverage, block.column + x, block.row), offset = (x * 3 + channel) * CELL_BYTES;
        expected.writeFloatLE(active ? (active.offset + 1) * 17.25 + channel * 1000 : 0, offset);
        expected[offset + 4] = active ? active.offset % 4 : STATUS_OUTSIDE;
      }
      expect(bytes).toEqual(expected);
      for (let channel = 0; channel < 3; channel++) {
        expect(bytes.readFloatLE(block.byteOffset + channel * CELL_BYTES)).toBe((i + 1) * 17.25 + channel * 1000);
        expect(bytes[block.byteOffset + channel * CELL_BYTES + 4]).toBe(i % 4);
      }
      expect(shards[block.shard].sha256).toBe(sha(bytes));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('retries partial reads and writes at advancing buffer and file offsets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-short-io-'));
  const probe = await open(join(root, 'probe'), 'wx+');
  const prototype = Object.getPrototypeOf(probe) as FileHandle;
  const originalRead = prototype.read as (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) => Promise<{ bytesRead: number; buffer: Uint8Array }>;
  const originalWrite = prototype.write as (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) => Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  await probe.close();
  const reads: number[] = [], writes: number[] = [];
  const readSpy = vi.spyOn(prototype, 'read').mockImplementation((async function (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) {
    reads.push(offset);
    return originalRead.call(this, buffer, offset, Math.min(length, 7), position);
  }) as typeof prototype.read);
  const writeSpy = vi.spyOn(prototype, 'write').mockImplementation((async function (this: FileHandle, buffer: Uint8Array, offset: number, length: number, position: number) {
    writes.push(offset);
    return originalWrite.call(this, buffer, offset, Math.min(length, 7), position);
  }) as typeof prototype.write);
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, 340);
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    for (const channel of [1, 0]) {
      await writer.writeChannel(channel, { values: Float32Array.of(1.5 + channel, -2.25 - channel, 99.75 + channel), flags: Uint8Array.of(1, 2, 3), coverage } as GridField);
    }
    const shards = await writer.finish();
    for (let i = 0; i < 3; i++) {
      const block = layout.block(i), bytes = await readFile(localPath(root, shards[block.shard].key));
      for (let channel = 0; channel < 2; channel++) {
        expect(bytes.readFloatLE(block.byteOffset + channel * CELL_BYTES)).toBe([1.5 + channel, -2.25 - channel, 99.75 + channel][i]);
      }
      expect(shards[block.shard].sha256).toBe(sha(bytes));
    }
    expect(reads.some(offset => offset > 0)).toBe(true);
    expect(writes.some(offset => offset > 0)).toBe(true);
  } finally {
    readSpy.mockRestore();
    writeSpy.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it('preserves existing shard objects and sentinel when a writer publication conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-conflict-'));
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 85);
    const conflict = localPath(root, sampleShardKey('gfs', '20261104T000000Z', 'fine', 1));
    const sentinel = join(dirname(conflict), 'other-worker');
    await mkdir(dirname(conflict), { recursive: true });
    await writeFile(conflict, 'existing shard');
    await writeFile(sentinel, 'sentinel');
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    await writer.writeChannel(0, { values: Float32Array.of(11.5, 22.25, -33.75), flags: Uint8Array.of(0, 1, 2), coverage } as GridField);
    await expect(writer.finish()).rejects.toThrow();
    expect(await readFile(conflict, 'utf8')).toBe('existing shard');
    expect(await readFile(sentinel, 'utf8')).toBe('sentinel');
    expect(await readdir(dirname(conflict))).toEqual(expect.arrayContaining(['1.bin', 'other-worker']));
    expect(await readdir(dirname(conflict))).toHaveLength(2);
    await writer.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('cleans only its own files after midstream cancellation or concurrent close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-abort-'));
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, 170);
    const dir = dirname(localPath(root, sampleShardKey('gfs', '20261104T000000Z', 'fine', 0)));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sentinel'), 'other worker');
    const field = { values: Float32Array.of(11.5, 22.25, -33.75), flags: Uint8Array.of(0, 1, 2), coverage } as GridField;
    const controller = new AbortController();
    let checks = 0;
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (++checks === 5) controller.abort(new Error('midstream abort'));
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    const writer = createShardedSamplePackWriter(layout, coverage, target(root), { signal: controller.signal });
    await expect(writer.writeChannel(0, field)).rejects.toThrow('midstream abort');
    await writer.close();
    expect(await readdir(dir)).toEqual(['sentinel']);

    const concurrent = createShardedSamplePackWriter(layout, coverage, target(root));
    const writing = concurrent.writeChannel(0, field);
    await expect(concurrent.writeChannel(1, field)).rejects.toThrow('busy');
    const closing = concurrent.close();
    await expect(writing).rejects.toThrow('closed');
    await closing;
    await concurrent.close();
    expect(await readdir(dir)).toEqual(['sentinel']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('preserves pre-existing objects when merger publication conflicts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-merge-conflict-'));
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 85);
    const source = join(root, 'source'), out = join(root, 'out');
    const writer = createShardedSamplePackWriter(layout, coverage, target(source));
    await writer.writeChannel(0, { values: Float32Array.of(1.5, -2.25, 3.75), flags: Uint8Array.of(1, 2, 3), coverage } as GridField);
    const shards = await writer.finish();
    const conflict = localPath(out, sampleShardKey('gfs', '20261104T000000Z', 'fine', 1)), dir = dirname(conflict);
    await mkdir(dir, { recursive: true });
    await writeFile(conflict, 'existing shard');
    await writeFile(join(dir, 'sentinel'), 'other worker');
    await expect(mergeShardedSamplePacks(layout, [{ root: source, channelCount: 1, shards }], target(out))).rejects.toThrow();
    expect(await readFile(conflict, 'utf8')).toBe('existing shard');
    expect(await readdir(dir)).toEqual(['1.bin', 'sentinel']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each(['writer', 'merger'] as const)('rolls back only owned shards when %s publication is aborted', async kind => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-publish-abort-'));
  try {
    const g = grid(33, 1, false), coverage = coverageFor(g, [0, 1, 2]);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 85);
    const field = { values: Float32Array.of(1.5, -2.25, 3.75), flags: Uint8Array.of(1, 2, 3), coverage } as GridField;
    const out = join(root, 'out'), first = localPath(out, sampleShardKey('gfs', '20261104T000000Z', 'fine', 0)), dir = dirname(first);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sentinel'), 'other worker');
    const controller = new AbortController();
    vi.spyOn(controller.signal, 'throwIfAborted').mockImplementation(() => {
      if (existsSync(first)) controller.abort(new Error('publication abort'));
      if (controller.signal.aborted) throw controller.signal.reason;
    });
    if (kind === 'writer') {
      const writer = createShardedSamplePackWriter(layout, coverage, target(out), { signal: controller.signal });
      await writer.writeChannel(0, field);
      await expect(writer.finish()).rejects.toThrow('publication abort');
      await writer.close();
    } else {
      const source = join(root, 'source'), writer = createShardedSamplePackWriter(layout, coverage, target(source));
      await writer.writeChannel(0, field);
      const shards = await writer.finish();
      await expect(mergeShardedSamplePacks(layout, [{ root: source, channelCount: 1, shards }], target(out), { signal: controller.signal })).rejects.toThrow('publication abort');
    }
    expect(await readdir(dir)).toEqual(['sentinel']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function combined(root: string, shards: readonly { key: string }[]): Promise<Buffer> {
  return Buffer.concat(await Promise.all(shards.map(async shard => readFile(localPath(root, shard.key)))));
}

it.each([false, true])('writes bounded v5 shards equal to the dense pack, including wrap and partial clips (wrap=%s)', async wrap => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-writer-'));
  try {
    const g = grid(33, 19, wrap), columns = Math.ceil(g.width / SAMPLE_BLOCK_SIZE), slots = Array.from({ length: columns * Math.ceil(g.height / SAMPLE_BLOCK_SIZE) }, (_, i) => i);
    const coverage = coverageFor(g, slots), fields = denseFields(g, coverage, 3);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, fields.length, 4400);
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    for (const channel of [2, 0, 1]) await writer.writeChannel(channel, fields[channel]);
    const shards = await writer.finish();

    const masks = denseMasks(g, coverage), denseLayout = prepareSamplePackLayout(g, masks.output, masks.halo);
    const reference = createSamplePackBuilder(denseLayout, fields.length);
    fields.forEach((field, channel) => reference.writeChannel(channel, field));
    const referencePath = join(root, 'dense.bin'), expected = await reference.finish(referencePath);

    expect(await combined(root, shards)).toEqual(await readFile(referencePath));
    expect(shards.reduce((sum, shard) => sum + shard.bytes, 0)).toBe(expected.bytes);
    expect(shards.length).toBeGreaterThan(1);
    for (let index = 0; index < shards.length; index++) {
      const shard = shards[index], bytes = await readFile(localPath(root, shard.key));
      expect(shard.key).toBe(sampleShardKey('gfs', '20261104T000000Z', 'fine', index));
      expect(shard.bytes).toBe(bytes.byteLength);
      expect(shard.sha256).toBe(sha(bytes));
      expect(bytes.byteLength).toBeLessThanOrEqual(4400);
    }

    const files = await Promise.all(shards.map(shard => readFile(localPath(root, shard.key))));
    for (const [lat, lon] of [[g.lat0, 0], [g.lat0 - 15.5, 15.5], [g.lat0 - 18, wrap ? 32.5 : 32], [g.lat0 - 0.5, 0.5]]) {
      const sample = planSample(g, lat, lon)!;
      let plan;
      try { plan = planShardedPackedSample(layout, sample, [2, 0]); } catch { continue; }
      const bytes = files[plan.shard].subarray(plan.byteRange.offset, plan.byteRange.offset + plan.byteRange.length);
      for (const channel of plan.channels) {
        expect(packedCellsFromRange(plan, bytes, channel)).toEqual(sample.contributors.map(c => ({ value: fields[channel].values[c.index], flags: fields[channel].flags[c.index] })));
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('writes packed active-offset fields into a huge sparse grid without dense timeline allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-sparse-'));
  try {
    const g = grid(14400, 7201, true), columns = Math.ceil(g.width / SAMPLE_BLOCK_SIZE), last = (Math.ceil(g.height / SAMPLE_BLOCK_SIZE) - 1) * columns + columns - 1;
    const ids = Uint32Array.of(0, columns + 4, last), blockIds = ids.length;
    const output = new Uint8Array(blockIds * 32), halo = new Uint8Array(blockIds * 32);
    for (let i = 0; i < blockIds; i++) output[i * 32] = 1;
    const coverage = { width: g.width, height: g.height, wrapLongitude: true, gridHash: 'b'.repeat(64), blockIds: ids, offsets: Uint32Array.of(0, 1, 2, 3), output, halo };
    const layout = prepareShardedSamplePackLayout(g, ids, 1, 2000);
    const values = Float32Array.of(1.5, -2, NaN), flags = Uint8Array.of(0, 1, STATUS_OUTSIDE);
    const writer = createShardedSamplePackWriter(layout, coverage, target(root));
    await writer.writeChannel(0, { values, flags, coverage } as GridField);
    const shards = await writer.finish();
    expect(shards.map(shard => shard.bytes)).toEqual([17 * 17 * CELL_BYTES, (17 * 17 + 17) * CELL_BYTES]);
    expect(shards.map(shard => shard.sha256)).toEqual(await Promise.all(shards.map(async shard => sha(await readFile(localPath(root, shard.key))))));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects incomplete channels and cancellation without leaving final shards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-incomplete-'));
  try {
    const g = grid(5, 2, true), coverage = coverageFor(g, [0]), fields = denseFields(g, coverage, 2);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, 200);
    const incomplete = createShardedSamplePackWriter(layout, coverage, target(root));
    await incomplete.writeChannel(0, fields[0]);
    await expect(incomplete.finish()).rejects.toThrow('Incomplete');
    expect(await readdir(dirname(localPath(root, sampleShardKey('gfs', '20261104T000000Z', 'fine', 0))))).toEqual([]);

    const controller = new AbortController();
    const cancelled = createShardedSamplePackWriter(layout, coverage, { ...target(root), surfaceId: 'cancelled' }, { signal: controller.signal });
    controller.abort(new Error('writer cancelled'));
    await expect(cancelled.writeChannel(0, fields[0])).rejects.toThrow('writer cancelled');
    expect(await readdir(dirname(localPath(root, sampleShardKey('gfs', '20261104T000000Z', 'cancelled', 0)))).catch(() => [])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('merges worker packs with different shard boundaries by block and channel order', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-merge-'));
  try {
    const g = grid(33, 19, true), coverage = coverageFor(g, Array.from({ length: 6 }, (_, i) => i)), fields = denseFields(g, coverage, 3);
    const worker = async (channels: number, targetBytes: number, offset: number) => {
      const workerRoot = join(root, `worker-${offset}`);
      const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, channels, targetBytes);
      const writer = createShardedSamplePackWriter(layout, coverage, target(workerRoot, `w${offset}`));
      for (let channel = 0; channel < channels; channel++) await writer.writeChannel(channel, fields[offset + channel]);
      return { root: workerRoot, channelCount: channels, shards: await writer.finish(), layout };
    };
    const first = await worker(2, 3000, 0), second = await worker(1, 4000, 2);
    expect(first.shards.length).not.toBe(second.shards.length);

    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 3, 5000);
    const merged = await mergeShardedSamplePacks(layout, [first, second], target(join(root, 'final')));

    const masks = denseMasks(g, coverage), denseLayout = prepareSamplePackLayout(g, masks.output, masks.halo);
    const reference = createSamplePackBuilder(denseLayout, 3);
    fields.forEach((field, channel) => reference.writeChannel(channel, field));
    const expectedPath = join(root, 'expected.bin');
    await reference.finish(expectedPath);

    expect(await combined(join(root, 'final'), merged)).toEqual(await readFile(expectedPath));
    expect(merged.reduce((sum, shard) => sum + shard.storedCells, 0)).toBe(layout.storedCells);
    expect(merged.map(shard => shard.firstBlock)).toEqual(layout.shards.map(shard => shard.firstBlock));
    for (const [index, shard] of merged.entries()) {
      expect(shard.key).toBe(sampleShardKey('gfs', '20261104T000000Z', 'fine', index));
      expect(shard.sha256).toBe(sha(await readFile(localPath(join(root, 'final'), shard.key))));
    }

    const files = await Promise.all(merged.map(shard => readFile(localPath(join(root, 'final'), shard.key))));
    for (const [lat, lon] of [[g.lat0, 0], [g.lat0 - 15.5, 15.5], [g.lat0 - 18, 32.5]]) {
      const sample = planSample(g, lat, lon)!;
      let plan: ReturnType<typeof planShardedPackedSample>;
      try { plan = planShardedPackedSample(layout, sample, [2, 0]); } catch { continue; }
      const bytes = files[plan.shard].subarray(plan.byteRange.offset, plan.byteRange.offset + plan.byteRange.length);
      for (const channel of plan.channels) expect(packedCellsFromRange(plan, bytes, channel)).toEqual(sample.contributors.map(c => ({ value: fields[channel].values[c.index], flags: fields[channel].flags[c.index] })));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects corrupt, truncated, incomplete and cancelled worker packs without creating final shards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-merge-invalid-'));
  try {
    const g = grid(17, 17, false), coverage = coverageFor(g, [0, 1]), fields = denseFields(g, coverage, 1);
    const make = async () => {
      const workerRoot = join(root, `worker-${Math.random()}`);
      const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 1500);
      const writer = createShardedSamplePackWriter(layout, coverage, target(workerRoot, 'w'));
      await writer.writeChannel(0, fields[0]);
      return { root: workerRoot, channelCount: 1, shards: await writer.finish(), layout };
    };
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 1500), out = join(root, 'out');
    const cases: [string, (input: Awaited<ReturnType<typeof make>>) => Promise<unknown>][] = [
      ['hash', async input => { const path = localPath(input.root, input.shards[0].key), bytes = await readFile(path); bytes[0] ^= 1; await writeFile(path, bytes); }],
      ['truncated', async input => { const path = localPath(input.root, input.shards[0].key), bytes = await readFile(path); await writeFile(path, bytes.subarray(0, bytes.length - CELL_BYTES)); }],
      ['incomplete', async input => { Object.assign(input, { shards: input.shards.slice(0, -1) }); }]
    ];
    for (const [, mutate] of cases) {
      const input = await make();
      await mutate(input);
      await expect(mergeShardedSamplePacks(layout, [input], target(out))).rejects.toThrow();
      expect(await readdir(dirname(localPath(out, sampleShardKey('gfs', '20261104T000000Z', 'fine', 0)))).catch(() => [])).toEqual([]);
    }

    const cancelled = await make(), controller = new AbortController();
    controller.abort(new Error('merge cancelled'));
    await expect(mergeShardedSamplePacks(layout, [cancelled], target(join(root, 'cancelled')), { signal: controller.signal })).rejects.toThrow('merge cancelled');
    expect(await readdir(join(root, 'cancelled')).catch(() => [])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('writes and merges sparse profile records with explicit outside columns and non-scalar strides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-profiles-'));
  try {
    const g = grid(33, 19, true), coverage = coverageFor(g, [0, 1, 2, 3, 4, 5]), recordBytes = profileRecordBytes(2);
    const outsideRecord = new Uint8Array(recordBytes);
    writeProfileRecord(outsideRecord, { modelTerrainM: null, status: 'outside-domain', levels: [] });
    const recordsFor = (channel: number) => {
      const count = coverage.offsets[coverage.offsets.length - 1], parent = new Uint8Array(count * recordBytes + 7);
      const records = parent.subarray(3, -4);
      for (let i = 0; i < count; i++) writeProfileRecord(records.subarray(i * recordBytes, (i + 1) * recordBytes), {
        modelTerrainM: i * 10 + channel, status: 'valid', levels: [{ pressureHpa: 900, heightM: 1000 + i,
          temperatureC: 20 + channel, dewPointC: null, uWindMps: i, vWindMps: -i, omegaPaS: null }]
      });
      return records;
    };
    const workers = [];
    for (const channel of [0, 1]) {
      const workerRoot = join(root, `worker-${channel}`), layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, channel ? 40_000 : 12_000, recordBytes);
      const writer = createShardedSamplePackWriter(layout, coverage, { ...target(workerRoot, 'native'), kind: 'profiles', group: channel });
      await expect(writer.writeChannel(0, { values: new Float32Array(coverage.offsets.at(-1)!), flags: new Uint8Array(coverage.offsets.at(-1)!), coverage } as GridField)).rejects.toThrow('five-byte');
      await expect(writer.writeRawChannel(0, recordsFor(channel), { outsideRecord: outsideRecord.subarray(1) })).rejects.toThrow('shape');
      await writer.writeRawChannel(0, recordsFor(channel), { outsideRecord });
      await expect(writer.writeRawChannel(0, recordsFor(channel), { outsideRecord })).rejects.toThrow('already written');
      const shards = await writer.finish();
      expect(shards.every(shard => shard.key.includes(`/native/profiles/g${channel}-b`))).toBe(true);
      workers.push({ root: workerRoot, channelCount: 1, recordBytes, shards });
    }
    expect(workers[0].shards.length).toBeGreaterThan(workers[1].shards.length);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, 30_000, recordBytes), out = join(root, 'merged');
    await expect(mergeShardedSamplePacks(layout, [{ ...workers[0], recordBytes: 5 }, workers[1]], target(out))).rejects.toThrow('width mismatch');
    const shards = await mergeShardedSamplePacks(layout, workers, { ...target(out, 'native'), kind: 'profiles' });
    const files = await Promise.all(shards.map(async shard => {
      const bytes = await readFile(localPath(out, shard.key));
      expect(shard.sha256).toBe(sha(bytes));
      expect(bytes.byteLength).toBe(shard.bytes);
      return bytes;
    }));
    for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
      const block = layout.block(ordinal), bytes = files[block.shard];
      for (let row = 0; row < block.height; row++) for (let column = 0; column < block.width; column++) {
        const lookup = sparseCoverageLookup(coverage, (block.column + column) % g.width, block.row + row);
        for (let channel = 0; channel < 2; channel++) {
          const offset = block.byteOffset + ((row * block.width + column) * 2 + channel) * recordBytes;
          const record = bytes.subarray(offset, offset + recordBytes);
          validateProfileRecord(record);
          if (lookup) expect(record).toEqual(Buffer.from(recordsFor(channel).subarray(lookup.offset * recordBytes, (lookup.offset + 1) * recordBytes)));
          else expect(record).toEqual(Buffer.from(outsideRecord));
        }
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('aligns raw profile transposition across the 1 MiB write boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-profile-chunks-'));
  try {
    const g = { ...grid(256, 256, true), lat0: 80, dx: 360 / 256, dy: -0.5 }, output = new Uint8Array(g.width * g.height / 8).fill(255), halo = new Uint8Array(output.length);
    const coverage = sparseCoverageFromDense({ width: g.width, height: g.height, wrapLongitude: true, gridHash: 'a'.repeat(64), output, halo });
    const recordBytes = 22, count = coverage.offsets[coverage.offsets.length - 1], outsideRecord = new Uint8Array(recordBytes);
    writeProfileRecord(outsideRecord, { modelTerrainM: null, status: 'outside-domain', levels: [] });
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 2, 64 * 1024 * 1024, recordBytes), writer = createShardedSamplePackWriter(layout, coverage, { ...target(root, 'native'), kind: 'profiles' });
    for (const channel of [1, 0]) {
      const records = new Uint8Array(count * recordBytes);
      for (let i = 0; i < count; i++) writeProfileRecord(records.subarray(i * recordBytes, (i + 1) * recordBytes), {
        modelTerrainM: i % 2000, status: 'valid', levels: [{ pressureHpa: 900, heightM: 3000,
          temperatureC: channel, dewPointC: null, uWindMps: i % 100, vWindMps: null, omegaPaS: null }]
      });
      await writer.writeRawChannel(channel, records, { outsideRecord });
    }
    const shards = await writer.finish(), bytes = await readFile(localPath(root, shards[0].key));
    expect(layout.byteLength / 2).toBeGreaterThan(1024 * 1024);
    for (const index of [0, 40000, 65535]) {
      const active = sparseCoverageLookup(coverage, index % g.width, Math.floor(index / g.width))!.offset;
      const sample = planSample(g, g.lat0 + Math.floor(index / g.width) * g.dy, (index % g.width) * g.dx)!, plan = planShardedPackedSample(layout, sample, [0, 1]);
      const range = bytes.subarray(plan.byteRange.offset, plan.byteRange.offset + plan.byteRange.length);
      for (const channel of [0, 1]) expect(readProfileRecord(packedRecordsFromRange(plan, range, channel)[0])).toMatchObject({
        modelTerrainM: active % 2000, levels: [{ temperatureC: channel, uWindMps: active % 100 }]
      });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('streams a raw block larger than the write chunk without losing records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-wide-block-'));
  try {
    const g = grid(17, 17, false), coverage = coverageFor(g, [0]), recordBytes = 4096;
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 64 * 1024 * 1024, recordBytes);
    expect(layout.block(0).byteLength).toBeGreaterThan(1024 * 1024);
    const writer = createShardedSamplePackWriter(layout, coverage, { ...target(root, 'native'), kind: 'profiles' });
    const record = new Uint8Array(recordBytes).fill(23), outsideRecord = new Uint8Array(recordBytes).fill(47);
    await writer.writeRawChannel(0, record, { outsideRecord });
    const shards = await writer.finish(), bytes = await readFile(localPath(root, shards[0].key));
    expect(bytes.byteLength).toBe(layout.byteLength);
    expect(bytes.subarray(0, recordBytes).every(value => value === 23)).toBe(true);
    expect(bytes.subarray(recordBytes).every(value => value === 47)).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('streams borrowed raw records at global grid indices with byte-identical halos', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-v5-callback-'));
  try {
    const g = grid(33, 19, true), coverage = coverageFor(g, [0, 1, 2, 3, 4, 5]), recordBytes = profileRecordBytes(1);
    const layout = prepareShardedSamplePackLayout(g, coverage.blockIds, 1, 12_000, recordBytes), count = coverage.offsets.at(-1)!;
    const records = new Uint8Array(count * recordBytes), outsideRecord = new Uint8Array(recordBytes), scratch = new Uint8Array(recordBytes);
    writeProfileRecord(outsideRecord, { modelTerrainM: null, status: 'outside-domain', levels: [] });
    for (let i = 0; i < count; i++) writeProfileRecord(records.subarray(i * recordBytes, (i + 1) * recordBytes), {
      modelTerrainM: i, surfacePressureHpa: 1000 - i, status: 'valid', levels: [{ pressureHpa: 900, heightM: 1000,
        temperatureC: i, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null }]
    });
    const arrayRoot = join(root, 'array'), callbackRoot = join(root, 'callback');
    const arrayWriter = createShardedSamplePackWriter(layout, coverage, { ...target(arrayRoot, 'native'), kind: 'profiles' });
    await arrayWriter.writeRawChannel(0, records, { outsideRecord });
    const arrayShards = await arrayWriter.finish(), calls: number[] = [];
    const callbackWriter = createShardedSamplePackWriter(layout, coverage, { ...target(callbackRoot, 'native'), kind: 'profiles' });
    await callbackWriter.writeRawChannel(0, index => {
      calls.push(index);
      const offset = sparseCoverageLookup(coverage, index % g.width, Math.floor(index / g.width))!.offset;
      scratch.set(records.subarray(offset * recordBytes, (offset + 1) * recordBytes));
      return scratch;
    }, { outsideRecord });
    const callbackShards = await callbackWriter.finish();
    expect(callbackShards).toEqual(arrayShards);
    expect(calls).toContain(16);
    expect(calls.filter(index => index === 16).length).toBeGreaterThan(1);
    for (const shard of callbackShards) expect(await readFile(localPath(callbackRoot, shard.key))).toEqual(await readFile(localPath(arrayRoot, shard.key)));
    const failedRoot = join(root, 'failed'), invalid = createShardedSamplePackWriter(layout, coverage, { ...target(failedRoot, 'native'), kind: 'profiles' });
    await expect(invalid.writeRawChannel(0, () => scratch.subarray(1), { outsideRecord })).rejects.toThrow('callback record width');
    await invalid.close();
    expect(await readdir(dirname(localPath(failedRoot, sampleShardKey('gfs', '20261104T000000Z', 'native', 0, undefined, 'profiles')))).catch(() => [])).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
