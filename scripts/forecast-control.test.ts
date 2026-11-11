import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeBoundedJson, MAX_MANIFEST_BYTES } from '@av/contracts';
import { expect, it, vi } from 'vitest';
import { BUILD_BUDGETS, MAX_V5_SHARD_BYTES } from '../apps/batch/src/capacity.js';
import { putImmutableReceipt, type ObjectReceipt } from '../apps/batch/src/immutable-upload.js';
import type { BuildPlan } from '../apps/batch/src/parallel.js';
import type { ObjectStorage } from '../apps/batch/src/storage.js';
import { sha256 } from '../apps/batch/src/validate.js';
import { TerrainTestStorage } from '../apps/batch/src/terrain/test-fixtures.js';
import { completeForecastControlShard, downloadForecastControlReceipts, uploadForecastControlPlan } from './forecast-control.js';

class ControlStorage extends TerrainTestStorage {
  metadata = new Map<string, Record<string, string> | undefined>();
  override async head(key: string) {
    const head = await super.head(key);
    return head && { ...head, metadata: this.metadata.get(key) };
  }
  override async put(...[key, bytes, condition, , , metadata]: Parameters<ObjectStorage['put']>) {
    await super.put(key, bytes, condition);
    this.metadata.set(key, metadata);
  }
}

it('finalizes only verified receipts for the immutable plan and reuses a completed shard', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-forecast-control-'));
  const store = new ControlStorage(), signal = new AbortController().signal;
  const plan = { model: 'gfs', buildId: '20261111T080000Z-00000000-0000-4000-8000-000000000000',
    createdAt: new Date().toISOString(), groups: [[1], [2]] } as BuildPlan;
  const source = join(root, 'source'), destination = join(root, 'destination');
  const control = `builds/${plan.model}/${plan.buildId}/_control`;
  const payloads = ['{"shard":0}', '{"shard":1}'];
  try {
    await mkdir(source);
    await mkdir(destination);
    await writeFile(join(source, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(destination, 'plan.json'), JSON.stringify(plan));
    await uploadForecastControlPlan(store, source, plan);
    const build = vi.fn(async (shard: number) => {
      const file = join(source, `receipt-${shard}.json`);
      await writeFile(file, payloads[shard]);
      return file;
    });
    const first = join(source, 'first.json');
    await completeForecastControlShard(store, plan, 0, first, () => build(0), signal);
    await completeForecastControlShard(store, plan, 0, first, () => build(0), signal);
    expect(build).toHaveBeenCalledOnce();
    expect(await readFile(first, 'utf8')).toBe(payloads[0]);
    await expect(downloadForecastControlReceipts(store, destination, plan, signal)).rejects.toThrow('Missing forecast shard receipt');
    await rm(join(destination, 'shards'), { recursive: true, force: true });
    await completeForecastControlShard(store, plan, 1, join(source, 'second.json'), () => build(1), signal);
    const key = `${control}/shards/1/receipt.json`;
    const bytes = store.objects.get(key)!;
    store.objects.set(key, Buffer.from('{"shard":0}'));
    await expect(downloadForecastControlReceipts(store, destination, plan, signal)).rejects.toThrow('integrity mismatch');
    await rm(join(destination, 'shards'), { recursive: true, force: true });
    store.objects.set(key, bytes);
    await downloadForecastControlReceipts(store, destination, plan, signal);
    for (const shard of [0, 1]) expect(await readFile(join(destination, 'shards', String(shard), 'receipt.json'), 'utf8')).toBe(payloads[shard]);
    await writeFile(join(destination, 'plan.json'), '{}');
    await expect(downloadForecastControlReceipts(store, destination, plan, signal)).rejects.toThrow('differs from the workflow plan');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function payloadReceipt(plan: BuildPlan, objects: readonly ObjectReceipt[]) {
  const prefix = `builds/${plan.model}/${plan.buildId}`;
  const sample = { firstBlock: 0, blockCount: 1, storedCells: 1, bytes: 5, key: `${prefix}/surfaces/native/samples/0.bin`, sha256: 'a'.repeat(64) };
  return { version: 2, planHash: sha256(encodeBoundedJson(plan, MAX_MANIFEST_BYTES)), shard: 0,
    artifacts: [], provenance: [{ hour: 1, frame: 'f001', bytes: 8, key: `${prefix}/provenance/f001.json`, sha256: 'b'.repeat(64) }],
    surfaces: [{ id: 'native', channelCount: 1, shards: [sample] }], objects,
    metrics: { frames: {}, phasesMs: { acquireMs: 0, deriveMs: 0, packMs: 0, renderMs: 0 }, renderer: {}, acquisition: {}, elapsedMs: 0, peakRssBytes: 0 } };
}

async function payloadFixture() {
  const store = new ControlStorage(), signal = new AbortController().signal;
  const plan = { model: 'gfs', buildId: '20261111T080000Z-00000000-0000-4000-8000-000000000000',
    createdAt: new Date().toISOString(), groups: [[1]] } as BuildPlan;
  const prefix = `builds/${plan.model}/${plan.buildId}`;
  const objects = [await putImmutableReceipt(store, `${prefix}/usable-lift-agl/f001.pmtiles`, Uint8Array.of(1, 2), 'application/octet-stream', signal),
    await putImmutableReceipt(store, `${prefix}/provenance/f001.json`, Buffer.from('{"ok":true}'), 'application/json', signal)];
  const receipt = payloadReceipt(plan, objects);
  const seed = (value = receipt) => putImmutableReceipt(store, `${prefix}/_control/shards/0/receipt.json`, Buffer.from(JSON.stringify(value)), 'application/json', signal);
  return { store, plan, objects, receipt, signal, seed };
}

it('restores complete payload files from a reusable receipt only for full-artifact retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-forecast-payload-'));
  const { store, plan, objects, signal, seed } = await payloadFixture();
  const build = vi.fn<() => Promise<string>>(), ordinary = join(root, 'ordinary.json'), full = join(root, 'full.json');
  try {
    await seed();
    const get = vi.spyOn(store, 'get');
    await completeForecastControlShard(store, plan, 0, ordinary, build, signal);
    expect(get).toHaveBeenCalledOnce();
    await expect(readFile(join(root, objects[0]!.key))).rejects.toMatchObject({ code: 'ENOENT' });
    get.mockClear();
    await completeForecastControlShard(store, plan, 0, full, build, signal, root);
    expect(build).not.toHaveBeenCalled();
    expect(await readFile(full)).toEqual(await readFile(ordinary));
    for (const [index, object] of objects.entries()) {
      expect(await readFile(join(root, object.key))).toEqual(Buffer.from(store.objects.get(object.key)!));
      expect(get).toHaveBeenNthCalledWith(index + 2, object.key, undefined, object.bytes, signal, undefined, object);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([
  ['plan', 'receipt identity mismatch', 1],
  ['other-build', 'payload key is invalid', 1],
  ['traversal', 'payload key is invalid', 1],
  ['duplicate', 'payload key is invalid', 1],
  ['oversize', 'Too big', 1],
  ['numeric-oversize', 'numeric payload exceeds byte budget', 1],
  ['digest', 'payload integrity mismatch', 2],
  ['etag', 'payload integrity mismatch', 2],
  ['length', 'payload integrity mismatch', 2]
] as const)(
  'rejects %s before writing the final retry receipt', async (failure, expected, reads) => {
    const root = await mkdtemp(join(tmpdir(), 'av-forecast-payload-invalid-'));
    const { store, plan, objects, receipt, signal, seed } = await payloadFixture(), object = objects[0]!;
    const destination = join(root, 'receipt.json');
    try {
      if (failure === 'plan') receipt.planHash = '0'.repeat(64);
      if (failure === 'other-build') receipt.objects = [{ ...object, key: object.key.replace('/gfs/', '/rrfs/') }];
      if (failure === 'traversal') receipt.objects = [{ ...object, key: object.key.replace('/usable-lift-agl/', '/../') }];
      if (failure === 'duplicate') receipt.objects = [object, object];
      if (failure === 'oversize') receipt.objects = [{ ...object, bytes: BUILD_BUDGETS.samplePackBytes + 1 }];
      if (failure === 'numeric-oversize') receipt.objects = [{ ...object, key: receipt.surfaces[0]!.shards[0]!.key, bytes: MAX_V5_SHARD_BYTES + 1 }];
      await seed(receipt);
      const original = store.get.bind(store);
      const get = vi.spyOn(store, 'get').mockImplementation(async (key, ...args) => {
        const value = await original(key, ...args);
        if (!value || key !== object.key) return value;
        if (failure === 'digest') return { ...value, bytes: Uint8Array.of(0, 0) };
        if (failure === 'etag') return { ...value, etag: 'changed' };
        if (failure === 'length') return { ...value, bytes: Uint8Array.of(0) };
        return value;
      });
      await expect(completeForecastControlShard(store, plan, 0, destination, vi.fn(), signal, root)).rejects.toThrow(expected);
      expect(get).toHaveBeenCalledTimes(reads);
      await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
