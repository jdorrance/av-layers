import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareShardedSamplePackLayout } from '@av/forecast';
import type { RegularLatLonGrid } from '@av/contracts';
import { TerrainTestStorage } from './terrain/test-fixtures.js';
import { sampleShardKey } from './sample-pack-v5.js';
import { servingGroupResources, writeServingGroups, type HourSamplePart } from './serving-groups.js';

const grid: RegularLatLonGrid = { kind: 'regular-latlon', width: 33, height: 17, lon0: 0, lat0: 16, dx: 1, dy: -1, wrapLongitude: true, earthRadiusM: 6371229 };
const blocks = Uint32Array.of(0, 1, 2, 3, 4, 5), layers = 2;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
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
  const layout = prepareShardedSamplePackLayout(grid, blocks, frameCount * layers);
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
it('settles cancellation and removes staged files without publishing an incomplete group', async () => {
  const input = await fixture(), controller = new AbortController(), get = input.store.get.bind(input.store);
  vi.spyOn(input.store, 'get').mockImplementation(async (...args) => { const result = await get(...args); controller.abort(new Error('stop compaction')); return result; });
  await expect(writeServingGroups({ ...input, signal: controller.signal })).rejects.toThrow('stop compaction');
  expect(input.store.buffers).toEqual([]);
  expect((await readdir(input.root)).filter(name => name.startsWith('.serving-'))).toEqual([]);
});
