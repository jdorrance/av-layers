import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { storedModelPointerSchema, type CoverageMask, type ProductDefinition } from '@av/contracts';
import type { ForecastProvider } from './provider.js';
import { syntheticWholeDomain } from '../../../scripts/fixtures/whole-domain.js';
import { fixtureProvider, mask, product, PublicationStore } from '../parallel-fixtures.js';
import { workflowAuthority } from './authority.js';
import { buildShard, createBuildPlan, finalizeBuild, parseForecastShardReceipt, verifyBuildReceipts } from './parallel.js';
import { publish, rollback } from './publication.js';
import { buildObjects, forecastObjects } from './publication-objects.js';
import { validateBuild } from './validate.js';

const overrides = vi.hoisted(() => ({ product: undefined as ProductDefinition | undefined, provider: undefined as ForecastProvider | undefined, mask: undefined as CoverageMask | undefined, fine: undefined as Awaited<ReturnType<typeof syntheticWholeDomain>>['fine'] | undefined }));
vi.mock('@av/contracts/models', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/contracts/models')>();
  return { ...actual, getProduct: (id: string) => id === 'gfs' && overrides.product ? overrides.product : actual.getProduct(id) };
});
vi.mock('./providers.js', async importOriginal => ({ ...await importOriginal<typeof import('./providers.js')>(), getForecastProvider: () => overrides.provider }));
vi.mock('./coverage.js', async importOriginal => ({ ...await importOriginal<typeof import('./coverage.js')>(), loadCoverage: async () => overrides.mask }));
vi.mock('./whole-domain/coverage.js', async importOriginal => ({ ...await importOriginal<typeof import('./whole-domain/coverage.js')>(), loadBundledFineCoverage: async () => overrides.fine }));
vi.mock('./raster-pool.js', async importOriginal => ({ ...await importOriginal<typeof import('./raster-pool.js')>(), rasterWorkerCount: () => 0 }));

it('publishes opted-in sharded numeric data and serves its retained HTTP chunk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-numeric-workflow-')), store = new PublicationStore();
  try {
    const configured = { ...product, modelId: 'gfs', frameHours: [12, 24] }, source = fixtureProvider().provider;
    const provider: ForecastProvider = { ...source, async open(options) {
      const session = await source.open(options);
      return { ...session, async acquire(hour, target) {
        const frame = await session.acquire(hour, target), field = (value: number) => ({ values: new Float32Array(frame.activeIndices.length).fill(value), missing: new Uint8Array(frame.activeIndices.length) });
        frame.auxSurface = { u10mMps: field(4), v10mMps: field(2) };
        frame.auxLevels = { uWindMps: [field(6), field(8), field(10)], vWindMps: [field(3), field(4), field(5)] };
        return frame;
      } };
    } };
    overrides.product = configured; overrides.provider = provider; overrides.mask = mask;
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 3600000).toISOString();
    const wholeDomain = await syntheticWholeDomain(root, configured); overrides.fine = wholeDomain.fine;
    const plan = await createBuildPlan({ out: root, cycle, product: configured, mask, provider, shards: 2, store, numericWind: true, wholeDomain });
    expect(plan.numericWind).toBe(true);
    for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ out: root, plan, shard, product: configured, mask, provider, store });
    const receiptPath = join(root, 'shards/0/receipt.json'), original = await readFile(receiptPath), receipt = JSON.parse(original.toString());
    const manyObjects = structuredClone(receipt);
    manyObjects.numeric.objects = Array.from({ length: 257 }, (_, i) => ({ ...receipt.numeric.objects[0], key: `object-${i}` }));
    expect(parseForecastShardReceipt(Buffer.from(JSON.stringify(manyObjects)), plan, 0).numeric!.objects).toHaveLength(257);
    manyObjects.numeric.objects[0].bytes = 64 * 1024 * 1024 + 1;
    expect(() => parseForecastShardReceipt(Buffer.from(JSON.stringify(manyObjects)), plan, 0)).toThrow();
    delete receipt.numeric;
    await writeFile(receiptPath, JSON.stringify(receipt));
    await expect(finalizeBuild({ out: root, plan, product: configured, mask, provider, store })).rejects.toThrow('numeric frame mismatch');
    await writeFile(receiptPath, original);
    const invalidOverview = JSON.parse(original.toString());
    const overviewObject = invalidOverview.numeric.objects.find((object: { key: string }) => object.key.includes('/overview-'));
    expect(overviewObject).toBeDefined();
    overviewObject.key = overviewObject.key.replace('/overview-2-', '/overview-invalid-');
    await writeFile(receiptPath, JSON.stringify(invalidOverview));
    await expect(finalizeBuild({ out: root, plan, product: configured, mask, provider, store })).rejects.toThrow('numeric object mismatch');
    await writeFile(receiptPath, original);
    const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40), GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
    const manifestPath = await finalizeBuild({ out: root, plan, product: configured, mask, provider, store,
      onValidated: async result => {
        const get = vi.spyOn(store, 'get'), key = [...store.objects.keys()].find(item => /\/map-data\/.*\/wind-0\.bin$/.test(item))!;
        const object = store.objects.get(key)!, etag = object.etag;
        object.etag = 'tampered';
        await expect(publish(store, root, result.manifest, { authority, validated: result, receiptsOnly: true, publishNumericWind: true })).rejects.toThrow('receipt mismatch');
        object.etag = etag;
        get.mockClear();
        await publish(store, root, result.manifest, { authority, validated: result, receiptsOnly: true, publishNumericWind: true });
        expect(get.mock.calls.filter(([name, range]) => name.includes('/map-data/') && name.endsWith('.bin') && range)).toHaveLength(0);
        object.bytes[0] ^= 1;
        await expect(publish(store, root, result.manifest, { authority, validated: result, receiptsOnly: true })).rejects.toThrow('object corrupt');
        object.bytes[0] ^= 1;
        get.mockClear();
        await publish(store, root, result.manifest, { authority, validated: result, receiptsOnly: true });
        expect(get.mock.calls.some(([name, range]) => name.includes('/map-data/') && name.endsWith('.bin') && range)).toBe(true);
        get.mockRestore();
        // Verify buildObjects includes wind artifacts and validateBuild(..., remote) rejects missing wind receipts.
        const allObjects = await buildObjects(root, result.manifest, { store });
        expect(allObjects.length).toBeGreaterThan(forecastObjects(result.manifest).length);
        const receipts = await verifyBuildReceipts(root, result.manifest, store);
        await expect(validateBuild(root, result.manifest, mask, configured, {
          store,
          objects: receipts.filter(item => !item.key.endsWith('map-data.json'))
        })).rejects.toThrow('Remote receipt artifact set mismatch');
        // Verify rollback checks wind shards concurrently (bounded <= 4).
        const rawGet = store.get.bind(store);
        let activeRange = 0, peakRange = 0;
        const rangeSpy = vi.spyOn(store, 'get').mockImplementation(async (name, range, ...rest) => {
          if (!name.includes('/map-data/') || !range) return rawGet(name, range, ...rest);
          activeRange++; peakRange = Math.max(peakRange, activeRange);
          try { await new Promise(resolve => setTimeout(resolve, 15)); return await rawGet(name, range, ...rest); }
          finally { activeRange--; }
        });
        try {
          await rollback(store, 'gfs', result.manifest.buildId, authority);
          expect(peakRange).toBeGreaterThan(1);
          expect(peakRange).toBeLessThanOrEqual(4);
        } finally { rangeSpy.mockRestore(); }
        const head = store.head.bind(store);
        let active = 0, peak = 0, activeBytes = 0, peakBytes = 0;
        const maxShard = Math.max(...[...store.objects].filter(([name]) => name.includes('/map-data/') && name.endsWith('.bin')).map(([, item]) => item.bytes.length));
        const headSpy = vi.spyOn(store, 'head').mockImplementation(async name => {
          if (!name.includes('/map-data/') && !name.endsWith('/map-data.json')) return head(name);
          const size = store.objects.get(name)?.bytes.length ?? 0;
          active++; activeBytes += size; peak = Math.max(peak, active); peakBytes = Math.max(peakBytes, activeBytes);
          try { await new Promise(resolve => setTimeout(resolve, 25)); return await head(name); }
          finally { active--; activeBytes -= size; }
        });
        try {
          await publish(store, root, result.manifest, { authority, validated: result, publishNumericWind: true });
          expect(peak).toBe(1);
          expect(peakBytes).toBeLessThanOrEqual(2 * maxShard);
          expect(activeBytes).toBe(0);
        } finally { headSpy.mockRestore(); }
      } });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const pointer = storedModelPointerSchema.parse(JSON.parse(Buffer.from(store.objects.get('catalog/gfs/latest.json')!.bytes).toString()));
    expect(pointer.retained[0].mapData).toBeDefined();
    const bucket = { async get(key: string, options?: { range?: { offset: number; length: number } }) {
      const object = store.objects.get(key);
      if (!object) return null;
      const range = options?.range, bytes = range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes.slice();
      return { size: object.bytes.length, etag: object.etag, httpEtag: `"${object.etag}"`, customMetadata: object.metadata ?? {}, ...(range ? { range } : {}), body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }) };
    } };
    const path = '../../api/src/index.js';
    const api = await import(path) as { createApp(options: { products: Record<string, ProductDefinition> }): { fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> } };
    const app = api.createApp({ products: { gfs: configured } }), limiter = { async limit() { return { success: true }; } };
    const env = { BUCKET: bucket, SAMPLE_RATE_LIMITER: limiter, NUMERIC_RATE_LIMITER: limiter, AV_LOCAL_DEVELOPMENT: 'true', AV_RESPONSE_CACHE: 'off' }, ctx = { waitUntil() {} };
    const base = `http://localhost/v1/models/gfs/runs/${plan.buildId}/data/${manifest.frames[0].id}`;
    const descriptor = await app.fetch(new Request(base), env, ctx);
    expect(descriptor.status).toBe(200);
    const chunk = await app.fetch(new Request(`${base}/wind/0`), env, ctx);
    expect(chunk.status).toBe(200);
    expect((await chunk.arrayBuffer()).byteLength).toBeLessThanOrEqual(256 * 1024);
    const overview = await app.fetch(new Request(`${base}/overview-2/0`), env, ctx);
    expect(overview.status).toBe(200);
    const overviewBytes = (await overview.arrayBuffer()).byteLength;
    expect(overviewBytes).toBeGreaterThan(0);
    expect(overviewBytes).toBeLessThanOrEqual(256 * 1024);
  } finally { overrides.product = undefined; overrides.provider = undefined; overrides.mask = undefined; overrides.fine = undefined; await rm(root, { recursive: true, force: true }); }
}, 120_000);

it('finalizes opted-in numeric wind when a trailing shard lies past mapEndHour', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-numeric-short-map-')), store = new PublicationStore();
  try {
    const configured = { ...product, modelId: 'gfs', frameHours: [12, 24], mapEndHour: 12 }, source = fixtureProvider().provider;
    const provider: ForecastProvider = { ...source, async open(options) {
      const session = await source.open(options);
      return { ...session, async acquire(hour, target) {
        const frame = await session.acquire(hour, target), field = (value: number) => ({ values: new Float32Array(frame.activeIndices.length).fill(value), missing: new Uint8Array(frame.activeIndices.length) });
        frame.auxSurface = { u10mMps: field(4), v10mMps: field(2) };
        frame.auxLevels = { uWindMps: [field(6), field(8), field(10)], vWindMps: [field(3), field(4), field(5)] };
        return frame;
      } };
    } };
    overrides.product = configured; overrides.provider = provider; overrides.mask = mask;
    const cycle = new Date(Math.floor(Date.now() / 3600000) * 3600000 - 3600000).toISOString();
    const wholeDomain = await syntheticWholeDomain(root, configured); overrides.fine = wholeDomain.fine;
    const plan = await createBuildPlan({ out: root, cycle, product: configured, mask, provider, shards: 2, store, numericWind: true, wholeDomain });
    for (let shard = 0; shard < plan.groups.length; shard++) await buildShard({ out: root, plan, shard, product: configured, mask, provider, store });
    const tailReceiptPath = join(root, 'shards/1/receipt.json'), tailReceipt = JSON.parse(await readFile(tailReceiptPath, 'utf8'));
    expect(tailReceipt.numeric).toEqual({ frames: [], objects: [] });
    delete tailReceipt.numeric;
    await writeFile(tailReceiptPath, JSON.stringify(tailReceipt));
    const manifestPath = await finalizeBuild({ out: root, plan, product: configured, mask, provider, store });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    expect(manifest.mapFrameCount).toBe(1);
    expect(manifest.mapData).toBeDefined();
    const mapData = JSON.parse(Buffer.from(store.objects.get(`builds/gfs/${plan.buildId}/map-data.json`)!.bytes).toString());
    expect(mapData.frames).toHaveLength(1);
  } finally { overrides.product = undefined; overrides.provider = undefined; overrides.mask = undefined; overrides.fine = undefined; await rm(root, { recursive: true, force: true }); }
}, 120_000);
