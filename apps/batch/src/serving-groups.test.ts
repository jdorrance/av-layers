import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareShardedSamplePackLayout } from '@av/forecast';
import type { RegularLatLonGrid } from '@av/contracts';
import { TerrainTestStorage } from './terrain/test-fixtures.js';
import { sampleShardKey } from './sample-pack-v5.js';
import { servingGroupResources, writeServingGroups, type HourSamplePart } from './serving-groups.js';
import { MAX_V5_SHARD_BYTES } from './capacity.js';

const disk = vi.hoisted(() => ({ available: undefined as number | undefined, beforeCheck: undefined as (() => Promise<void>) | undefined, shardBytes: undefined as number | undefined }));
vi.mock('./capacity.js', async importOriginal => {
  const capacity = await importOriginal<typeof import('./capacity.js')>();
  return { ...capacity, get MAX_V5_SHARD_BYTES() { return disk.shardBytes ?? capacity.MAX_V5_SHARD_BYTES; } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, link: vi.fn(fs.link), statfs: async (path: string) => {
    const actual = await fs.statfs(path);
    await disk.beforeCheck?.();
    return disk.available === undefined ? actual : { ...actual, bavail: disk.available, bsize: 1 };
  } };
});

const grid: RegularLatLonGrid = { kind: 'regular-latlon', width: 33, height: 17, lon0: 0, lat0: 16, dx: 1, dy: -1, wrapLongitude: true, earthRadiusM: 6371229 };
const blocks = Uint32Array.of(0, 1, 2, 3, 4, 5), layers = 2;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => {
  disk.available = undefined; disk.beforeCheck = undefined; disk.shardBytes = undefined; vi.mocked(link).mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
class Store extends TerrainTestStorage {
  metadata = new Map<string, Record<string, string>>();
  buffers: ArrayBufferLike[] = [];
  override async head(key: string) { const item = await super.head(key); return item ? { ...item, metadata: this.metadata.get(key) } : null; }
  override async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _type?: string, _md5?: string, metadata?: Record<string, string>) {
    this.buffers.push(bytes.buffer);
    await super.put(key, bytes, condition);
    if (metadata) this.metadata.set(key, metadata);
  }
}
function packed(firstFrame: number, frameCount: number) {
  const layout = prepareShardedSamplePackLayout(grid, blocks, frameCount * layers, MAX_V5_SHARD_BYTES);
  const bytes = layout.shards.map(shard => Buffer.alloc(shard.byteLength));
  for (let b = 0; b < layout.blockCount; b++) {
    const block = layout.block(b), out = bytes[block.shard]!;
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) for (let f = 0; f < frameCount; f++) for (let layer = 0; layer < layers; layer++) {
      const index = (block.row + y) * grid.width + (block.column + x) % grid.width;
      const status = (index + firstFrame + f + layer) % 4, offset = block.byteOffset + ((y * block.width + x) * frameCount * layers + f * layers + layer) * 5;
      out.writeFloatLE(status >= 2 ? NaN : status === 1 ? 0 : index * 1000 + (firstFrame + f) * 10 + layer, offset);
      out[offset + 4] = status | ((index % 2) * 4);
    }
  }
  return { layout, bytes };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'av-serving-')); roots.push(root);
  const store = new Store(), parts: HourSamplePart[] = [];
  for (let firstFrame = 0; firstFrame < 40; firstFrame += 10) {
    const { layout, bytes } = packed(firstFrame, 10), group = firstFrame / 10;
    const shards = layout.shards.map((shard, index) => {
      const key = sampleShardKey('gfs', 'build', 'fine', index, group, 'samples', 'hour'), data = bytes[index]!;
      store.objects.set(key, data);
      return { key, bytes: data.length, sha256: digest(data), firstBlock: shard.firstBlock, blockCount: shard.blockCount, storedCells: shard.byteLength / (10 * layers * 5) };
    });
    parts.push({ firstFrame, frameCount: 10, shards });
  }
  return { root, store, parts, model: 'gfs', buildId: 'build', surfaceId: 'fine', grid, blockIds: blocks, layers };
}

async function localInputs(input: Awaited<ReturnType<typeof fixture>>, parts = input.parts): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const part of parts) for (const shard of part.shards) {
    const path = join(input.root, shard.key);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, input.store.objects.get(shard.key)!);
    keys.add(shard.key);
  }
  return keys;
}

it('admits existing local inputs with free space for outputs alone and preserves the originals', async () => {
  const input = await fixture(), keys = await localInputs(input), resources = servingGroupResources(input, keys);
  expect(resources.diskBytes).toBe(resources.outputBytes);
  expect(resources.diskBytes).toBeLessThan(servingGroupResources(input).diskBytes);
  disk.available = resources.outputBytes;
  const result = await writeServingGroups(input);
  expect(vi.mocked(link).mock.calls.filter(([, destination]) => String(destination).includes('/.serving-'))).toHaveLength(keys.size);
  for (const key of keys) {
    expect(input.store.gets.filter(read => read === key)).toEqual([]);
    expect(await readFile(join(input.root, key))).toEqual(Buffer.from(input.store.objects.get(key)!));
  }
  for (const shard of result.shards) expect(await readFile(join(input.root, shard.key))).toEqual(packed(shard.firstFrame, shard.frameCount).bytes[shard.blockShard]);
});

it.each([false, true])('admits remote input staging only when the peak additional bytes fit: %s', async enough => {
  const input = await fixture(), resources = servingGroupResources(input);
  disk.available = resources.diskBytes - (enough ? 0 : 1);
  if (enough) await expect(writeServingGroups(input)).resolves.toHaveProperty('shards');
  else {
    await expect(writeServingGroups(input)).rejects.toThrow('Insufficient serving compaction disk');
    expect(input.store.gets).toEqual([]);
    expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
  }
});

it('charges only missing inputs when local and remote source parts share a group', async () => {
  const input = await fixture(), keys = await localInputs(input, input.parts.slice(2));
  const resources = servingGroupResources(input, keys);
  expect(resources.diskBytes).toBeLessThan(servingGroupResources(input).diskBytes);
  disk.available = resources.diskBytes;
  await writeServingGroups(input);
  for (const part of input.parts) for (const shard of part.shards) expect(input.store.gets.filter(key => key === shard.key)).toHaveLength(keys.has(shard.key) ? 0 : 1);
});

it('fails if a local input disappears after admission instead of downloading unreserved bytes', async () => {
  const input = await fixture(), keys = await localInputs(input), key = [...keys][0]!;
  disk.available = servingGroupResources(input, keys).diskBytes;
  disk.beforeCheck = () => rm(join(input.root, key));
  await expect(writeServingGroups(input)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(input.store.gets).toEqual([]);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
});

it('lets the merger reject corrupted linked inputs before publishing serving objects', async () => {
  const input = await fixture(); await localInputs(input);
  const key = input.parts[0]!.shards[0]!.key, path = join(input.root, key), bytes = await readFile(path);
  bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes);
  await expect(writeServingGroups(input)).rejects.toThrow('Sample shard hash mismatch');
  expect(vi.mocked(link).mock.calls.some(([, destination]) => String(destination).includes('/.serving-'))).toBe(true);
  expect(input.store.buffers).toEqual([]);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
});
it('streams40 frames across a source-part boundary with exact values/flags and one GET per input', async () => {
  const input = await fixture(), result = await writeServingGroups(input);
  expect(result.shards.map(shard => [shard.firstFrame, shard.frameCount])).toEqual([[0, 24], [24, 16]]);
  for (const shard of result.shards) {
    const expected = packed(shard.firstFrame, shard.frameCount).bytes[shard.blockShard]!;
    expect(await readFile(join(input.root, shard.key))).toEqual(expected);
    expect(input.store.objects.get(shard.key)).toEqual(new Uint8Array(expected));
    expect(shard.sha256).toBe(digest(expected));
  }
  for (const part of input.parts) for (const shard of part.shards) expect(input.store.gets.filter(key => key === shard.key)).toHaveLength(1);
  expect(new Set(input.store.buffers).size).toBe(1);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
  const resources = servingGroupResources(input);
  expect(resources.sourceBytes).toBe(resources.outputBytes);
  expect(resources.workingBytes).toBeLessThan(300 * 1024 ** 2);
});
it('cleans staged files after a later failure and retries immutable completed outputs', async () => {
  const input = await fixture(), key = input.parts[3]!.shards[0]!.key, original = input.store.objects.get(key)!;
  input.store.objects.set(key, new Uint8Array(original.length));
  await expect(writeServingGroups(input)).rejects.toThrow('hash mismatch');
  expect(input.store.objects.has(sampleShardKey('gfs', 'build', 'fine', 0, 0))).toBe(true);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
  input.store.objects.set(key, original);
  const before = input.store.buffers.length;
  await expect(writeServingGroups(input)).resolves.toMatchObject({ shards: expect.arrayContaining([expect.objectContaining({ firstFrame: 24, frameCount: 16 })]) });
  expect(input.store.buffers.length - before).toBe(1);
});
it('uploads with two distinct reusable buffers, preserves order and exact bytes, and reserves both lanes', async () => {
  disk.shardBytes = 75 * 1024;
  const input = await fixture(), put = input.store.put.bind(input.store);
  let active = 0, peak = 0;
  vi.spyOn(input.store, 'put').mockImplementation(async (...args) => {
    active++; peak = Math.max(peak, active);
    try {
      const before = Buffer.from(args[1]);
      await new Promise(resolve => setTimeout(resolve, 2));
      expect(args[1]).toEqual(before);
      await put(...args);
    } finally { active--; }
  });
  const remote = servingGroupResources(input), local = servingGroupResources(input, new Set(), false);
  expect(remote.workingBytes - local.workingBytes).toBe(4 * MAX_V5_SHARD_BYTES);
  const result = await writeServingGroups(input);
  expect(peak).toBe(2); expect(active).toBe(0);
  expect(new Set(input.store.buffers).size).toBe(2);
  expect(result.objects.map(object => object.key)).toEqual(result.shards.map(shard => shard.key));
  for (const shard of result.shards) {
    const expected = packed(shard.firstFrame, shard.frameCount).bytes[shard.blockShard]!;
    expect(input.store.objects.get(shard.key)).toEqual(new Uint8Array(expected));
    expect(shard.sha256).toBe(digest(expected));
  }
  expect(result.phasesMs).toEqual({ stageMs: expect.any(Number), mergeMs: expect.any(Number), uploadMs: expect.any(Number) });
  expect(result.phasesMs.uploadMs).toBeGreaterThan(0);
});
it.each(['failure', 'abort'] as const)('drains both admitted uploads before cleanup on %s and retries immutable outputs', async mode => {
  disk.shardBytes = 75 * 1024;
  const input = await fixture(), controller = new AbortController(), put = input.store.put.bind(input.store);
  const keys: string[] = [];
  let release!: () => void, started!: () => void, active = 0, settled = false;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const admitted = new Promise<void>(resolve => { started = resolve; });
  const spy = vi.spyOn(input.store, 'put').mockImplementation(async (...args) => {
    keys.push(args[0]); active++;
    try {
      if (keys.length === 2) {
        started(); await blocked;
      } else if (keys.length === 1) {
        await admitted;
        if (mode === 'failure') throw new Error('upload failed');
        controller.abort(new Error('upload aborted'));
      }
      await put(...args);
    } finally { active--; }
  });
  const work = writeServingGroups({ ...input, signal: controller.signal }).finally(() => { settled = true; });
  const rejected = expect(work).rejects.toThrow(mode === 'failure' ? 'upload failed' : 'upload aborted');
  await admitted;
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(settled).toBe(false); expect(active).toBe(1); expect(keys).toHaveLength(2);
  expect((await readdir(input.root)).some(name => name.startsWith('.serving-'))).toBe(true);
  release(); await rejected;
  expect(active).toBe(0);
  expect((await readdir(input.root)).some(name => name.startsWith('.serving-'))).toBe(false);
  spy.mockRestore();
  const result = await writeServingGroups(input);
  expect(result.objects.map(object => object.key)).toEqual(result.shards.map(shard => shard.key));
  for (const shard of result.shards) expect(input.store.objects.get(shard.key)).toEqual(new Uint8Array(packed(shard.firstFrame, shard.frameCount).bytes[shard.blockShard]!));
});
it('settles cancellation and removes staged files without publishing an incomplete group', async () => {
  const input = await fixture(), controller = new AbortController(), get = input.store.get.bind(input.store);
  vi.spyOn(input.store, 'get').mockImplementation(async (...args) => { const result = await get(...args); controller.abort(new Error('stop compaction')); return result; });
  await expect(writeServingGroups({ ...input, signal: controller.signal })).rejects.toThrow('stop compaction');
  expect(input.store.buffers).toEqual([]);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
});
