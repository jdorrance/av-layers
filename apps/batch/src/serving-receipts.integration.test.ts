import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { manifestV5Schema, type ProductDefinition } from '@av/contracts';
import { syntheticWholeDomain } from '../../../scripts/fixtures/whole-domain.js';
import { CYCLE, cleanupTemporaryRoots, fixtureProvider, mask, product, PublicationStore, readManifest, temporaryRoot } from '../parallel-fixtures.js';
import { buildShard, createBuildPlan, finalizeBuild, verifyBuildReceipts, type WholeDomainReceipt } from './parallel.js';
import * as identity from './identity.js';

// Force multiple serving shards on the small grid to exercise the HEAD limit.
vi.mock('@av/forecast', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/forecast')>();
  return { ...actual, prepareShardedSamplePackLayout: (...args: Parameters<typeof actual.prepareShardedSamplePackLayout>) =>
    actual.prepareShardedSamplePackLayout(args[0], args[1], args[2], 5000, args[4]) };
});

let sealedRoot: string;
async function buildReceiptFixture() {
  const configured: ProductDefinition = { ...product, modelId: 'gfs', frameHours: [12, 24], terrainSubdivisionFactor: 4,
    layers: [...product.layers, 'sfc-temp-c'], execution: { ...product.execution, workers: 0 } };
  sealedRoot = await mkdtemp(join(tmpdir(), 'av-wd-remote-receipts-'));
  const wholeDomain = await syntheticWholeDomain(sealedRoot, configured);
  const inputs = { out: sealedRoot, product: configured, mask, provider: fixtureProvider().provider, store: new PublicationStore() };
  const plan = await createBuildPlan({ ...inputs, cycle: CYCLE, wholeDomain, shards: 2 });
  for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ ...inputs, plan, shard });
  return { inputs, plan, manifest: await readManifest(await finalizeBuild({ ...inputs, plan })) };
}
let receiptFixture: Awaited<ReturnType<typeof buildReceiptFixture>>;
beforeAll(async () => { receiptFixture = await buildReceiptFixture(); }, 60_000);
afterEach(cleanupTemporaryRoots);
afterAll(async () => { if (sealedRoot) await rm(sealedRoot, { recursive: true, force: true }); });

it('uses persisted upload receipts and hashes when the record is missing', async () => {
  const { inputs, plan, manifest } = receiptFixture, out = await temporaryRoot(), store = new PublicationStore();
  await cp(inputs.out, out, { recursive: true });
  store.objects = new Map(inputs.store.objects);
  const keys = new Set(manifest.surfaces.flatMap(surface => surface.samples.shards.map(shard => shard.key)));
  const get = vi.spyOn(store, 'get');
  await verifyBuildReceipts(out, manifest, store, undefined, inputs);
  expect(get.mock.calls.filter(([key]) => keys.has(key))).toHaveLength(0);
  await rm(join(out, `builds/${plan.model}/${plan.buildId}/serving-receipts.json`));
  get.mockClear();
  await verifyBuildReceipts(out, manifest, store, undefined, inputs);
  expect(get.mock.calls.filter(([key]) => keys.has(key))).toHaveLength(keys.size);
  const key = [...keys][0]!, original = store.objects.get(key)!;
  const bytes = original.bytes.slice(); bytes[0] ^= 1;
  store.objects.set(key, { ...original, bytes, etag: 'tampered' });
  await expect(verifyBuildReceipts(out, manifest, store, undefined, inputs)).rejects.toThrow('Remote object hash mismatch');
  get.mockRestore();
}, 60_000);

it('rejects changed serving object identity against a persisted receipt', async () => {
  const { inputs, manifest } = receiptFixture, store = new PublicationStore();
  store.objects = new Map(inputs.store.objects);
  const key = manifest.surfaces[0].samples.shards[0].key, original = store.objects.get(key)!;
  const bytes = original.bytes.slice(); bytes[0] ^= 1;
  store.objects.set(key, { ...original, bytes, etag: 'tampered' });
  await expect(verifyBuildReceipts(inputs.out, manifest, store, undefined, inputs)).rejects.toThrow('Remote object receipt mismatch');
}, 60_000);

it.each(['complete', 'failure', 'abort'] as const)('bounds serving receipt HEADs and drains admitted work: %s', async mode => {
  const controller = new AbortController(), pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  let running: ReturnType<typeof verifyBuildReceipts> | undefined;
  try {
    const { inputs, manifest } = receiptFixture;
    const store = new PublicationStore();
    store.objects = new Map(inputs.store.objects);
    const keys = manifest.surfaces.flatMap(surface => surface.samples.shards.map(shard => shard.key)), serving = new Set(keys);
    expect(keys.length).toBeGreaterThan(4);
    const head = store.head.bind(store), started: string[] = [];
    let active = 0, peak = 0, settled = false;
    vi.spyOn(store, 'head').mockImplementation(async key => {
      if (!serving.has(key)) return head(key);
      started.push(key); active++; peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve, reject) => { pending.set(key, { resolve, reject }); });
        return await head(key);
      } finally { active--; }
    });
    running = verifyBuildReceipts(inputs.out, manifest, store, controller.signal, inputs);
    void running.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(pending.size).toBe(4));
    if (mode === 'complete') {
      let completed = 0;
      while (completed < keys.length) {
        const batch = [...pending.values()]; pending.clear(); completed += batch.length;
        for (const gate of batch.reverse()) gate.resolve();
        if (completed < keys.length) await vi.waitFor(() => expect(pending.size).toBe(Math.min(4, keys.length - completed)));
      }
      const objects = await running;
      expect(objects.slice(0, keys.length).map(object => object.key)).toEqual(keys);
    } else {
      const error = new Error(`receipt HEAD ${mode}`);
      if (mode === 'failure') { pending.get(keys[0])!.reject(error); pending.delete(keys[0]); }
      else controller.abort(error);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(started).toHaveLength(4);
      for (const gate of pending.values()) gate.resolve(); pending.clear();
      await expect(running).rejects.toThrow(error.message);
      expect(started).toHaveLength(4);
    }
    expect(peak).toBe(4); expect(active).toBe(0);
  } finally {
    controller.abort(new Error('receipt HEAD test cleanup'));
    for (const gate of pending.values()) gate.resolve();
    await running?.catch(() => {});
  }
}, 60_000);

it('resumes identical producer receipts across commits while workers and finalizers keep their revision pin', async () => {
  const { inputs, plan, manifest } = receiptFixture;
  const originalPlan = await readFile(join(inputs.out, 'plan.json'));
  const originalManifest = structuredClone(manifest), originalIdentity = identity.buildIdentity;
  const currentRevision = 'b'.repeat(40);
  expect(currentRevision).not.toBe(plan.recipe.sourceRevision);
  const current = vi.spyOn(identity, 'buildIdentity').mockImplementation(async (...args) => {
    const result = await originalIdentity(...args);
    return { ...result, recipe: { ...result.recipe, sourceRevision: currentRevision } };
  });
  const open = vi.spyOn(inputs.provider, 'open'), put = vi.spyOn(inputs.store, 'put');
  try {
    await expect(verifyBuildReceipts(inputs.out, manifest, inputs.store, undefined, inputs)).resolves.not.toHaveLength(0);
    expect(manifest).toEqual(originalManifest);
    expect(await readFile(join(inputs.out, 'plan.json'))).toEqual(originalPlan);
    expect(await readManifest(join(inputs.out, 'builds', plan.model, plan.buildId, 'manifest.json'))).toEqual(originalManifest);
    await expect(buildShard({ ...inputs, plan, shard: 0 })).rejects.toThrow('recipe or source revision changed');
    await expect(finalizeBuild({ ...inputs, plan })).rejects.toThrow('recipe or source revision changed');
    expect(open).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  } finally { current.mockRestore(); open.mockRestore(); put.mockRestore(); }
});

it.each(['hash', 'sourceDirty', 'lockHash', 'id', 'source'] as const)('rejects changed producer %s during cross-commit receipt resume', async field => {
  const { inputs, manifest } = receiptFixture, originalIdentity = identity.buildIdentity;
  const current = vi.spyOn(identity, 'buildIdentity').mockImplementation(async (...args) => {
    const result = await originalIdentity(...args), recipe = { ...result.recipe, sourceRevision: 'b'.repeat(40) };
    if (field === 'sourceDirty') recipe.sourceDirty = !recipe.sourceDirty;
    else if (field === 'source') recipe.source = { ...recipe.source, configurationId: `${recipe.source.configurationId}-changed` };
    else if (field === 'id') recipe.id += '-changed';
    else recipe[field] = recipe[field] === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    return { ...result, recipe };
  });
  const put = vi.spyOn(inputs.store, 'put');
  try {
    await expect(verifyBuildReceipts(inputs.out, manifest, inputs.store, undefined, inputs)).rejects.toThrow('recipe or source revision changed');
    expect(put).not.toHaveBeenCalled();
  } finally { current.mockRestore(); put.mockRestore(); }
});

it('rejects prebranch g-key receipts during finalize and receipt-only resume before payload mutation', async () => {
  const sealed = receiptFixture, out = await temporaryRoot(), store = new PublicationStore();
  await cp(sealed.inputs.out, out, { recursive: true });
  store.objects = new Map(sealed.inputs.store.objects);
  const { plan } = sealed, manifest = structuredClone(sealed.manifest);
  const inputs = { ...sealed.inputs, out, store };
  for (const surface of manifest.surfaces) for (const item of surface.samples.shards) {
    await rm(join(out, item.key)); store.objects.delete(item.key);
  }
  const originals = new Map<string, Uint8Array>();
  const receipts: WholeDomainReceipt[] = [];
  for (let shard = 0; shard < plan.groups.length; shard++) {
    const path = join(out, `shards/${shard}/receipt.json`);
    const receipt = JSON.parse(await readFile(path, 'utf8')) as WholeDomainReceipt;
    for (const surface of receipt.surfaces) for (const item of surface.shards) {
      const previous = item.key, legacy = previous.replace('/samples/src-g', '/samples/g'), object = store.objects.get(previous)!;
      await rename(join(out, previous), join(out, legacy)); store.objects.delete(previous); store.objects.set(legacy, object);
      originals.set(legacy, object.bytes.slice());
      item.key = legacy;
      receipt.objects!.find(object => object.key === previous)!.key = legacy;
    }
    await writeFile(path, JSON.stringify(receipt));
    receipts.push(receipt);
  }
  for (const surface of manifest.surfaces) {
    if (surface.samples.format !== 'frame-group-block-shards-v1') throw new Error('Expected grouped samples');
    let firstFrame = 0;
    surface.samples.shards = receipts.flatMap(receipt => {
      const part = receipt.surfaces.find(part => part.id === surface.id);
      if (!part) throw new Error('Missing legacy surface');
      const frameCount = plan.groups[receipt.shard].length, start = firstFrame;
      firstFrame += frameCount;
      return part.shards.map((item, blockShard) => ({ ...item, group: receipt.shard, firstFrame: start, frameCount, blockShard }));
    });
  }
  const legacy = manifestV5Schema.parse(manifest);
  const put = vi.spyOn(store, 'put');
  const stale = { ...plan, recipe: { ...plan.recipe, hash: '0'.repeat(64), sourceRevision: '93e69f6d8ba9a1a8368d1e8d48d7adecff56a2de', sourceDirty: false } };
  await expect(finalizeBuild({ ...inputs, plan: stale })).rejects.toThrow('recipe or source revision changed; start a fresh forecast');
  await expect(finalizeBuild({ ...inputs, plan })).rejects.toThrow('Legacy forecast sample receipts');
  await expect(verifyBuildReceipts(out, legacy, store, undefined, inputs)).rejects.toThrow('Legacy forecast sample receipts');
  expect(put).not.toHaveBeenCalled();
  for (const [key, bytes] of originals) {
    expect(await readFile(join(out, key))).toEqual(Buffer.from(bytes));
    expect(store.objects.get(key)!.bytes).toEqual(bytes);
  }
}, 60_000);
