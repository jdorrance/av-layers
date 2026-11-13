import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { R2Bucket } from '@cloudflare/workers-types';
import { expect, it, vi } from 'vitest';
import { gridToGeographic, gridVectorToEarth, prepareGridGeometry, profileResponseSchema, sampleResponseV5Schema, type ModelDefinition } from '@av/contracts';
import { writeCoverage } from '../apps/batch/src/coverage.js';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import { createIndexedGribProvider } from '../apps/batch/src/indexed-grib/provider.js';
import { buildShard, createBuildPlan, finalizeBuild } from '../apps/batch/src/parallel.js';
import { publish } from '../apps/batch/src/publication.js';
import type { ObjectStorage } from '../apps/batch/src/storage.js';
import { completeForecastControlShard, downloadForecastControlReceipts, forecastPlanSignal, uploadForecastControlPlan } from './forecast-control.js';
import { UPP_NORTH, UPP_SOUTH } from './fixtures/upp-products.js';
import { denseFixtureMask, syntheticWholeDomain } from './fixtures/whole-domain.js';
import { publishUppFixture } from './fixtures/upp-lambert-grib.js';

const fixtureRegistry = vi.hoisted(() => new Map<string, ModelDefinition>());
vi.mock('@av/contracts/models', async importOriginal => {
  const actual = await importOriginal<typeof import('@av/contracts/models')>();
  return { ...actual, getProduct: (id: string) => fixtureRegistry.get(id) ?? actual.getProduct(id) };
});
const fixtureRuns = [
  { product: UPP_NORTH, cycleHourUtc: 8 },
  { product: UPP_SOUTH, cycleHourUtc: 0 }
];

const config = fileURLToPath(new URL('../apps/api/wrangler.json', import.meta.url));
const contractDir = fileURLToPath(new URL('../packages/contracts/', import.meta.url));
const WRANGLER_LIFECYCLE_MS = 30_000;

async function withWranglerDeadline<T>(phase: string, operation: Promise<T>, disposeLate?: (value: T) => Promise<void>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      if (disposeLate) void operation.then(disposeLate, () => {}).catch(error => console.error(`WRF fixture late ${phase} cleanup failed`, error));
      reject(new Error(`WRF fixture ${phase} timed out after ${WRANGLER_LIFECYCLE_MS} ms`));
    }, WRANGLER_LIFECYCLE_MS).unref();
  });
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}

function boundStorage(bucket: R2Bucket): ObjectStorage {
  return {
    async get(key, range, maximum, signal, _onRetry, identity) {
      signal?.throwIfAborted();
      const object = await bucket.get(key, { range, onlyIf: identity ? { etagMatches: identity.etag.slice(1, -1) } : undefined });
      signal?.throwIfAborted();
      if (!object) return null;
      if (!('arrayBuffer' in object) || (identity && (object.size !== identity.bytes || object.httpEtag !== identity.etag))) throw new Error('Fixture object precondition failed');
      const length = range?.length ?? object.size;
      if (maximum !== undefined && length > maximum) throw new Error('Fixture object exceeds read budget');
      return { bytes: new Uint8Array(await object.arrayBuffer()), etag: object.httpEtag };
    },
    async head(key, signal) {
      signal?.throwIfAborted();
      const object = await bucket.head(key);
      return object ? { size: object.size, etag: object.httpEtag, metadata: object.customMetadata } : null;
    },
    async put(key, bytes, condition, contentType, md5, customMetadata) {
      const object = await bucket.put(key, Uint8Array.from(bytes).buffer, {
        onlyIf: { etagDoesNotMatch: condition.ifNoneMatch, etagMatches: condition.ifMatch?.replace(/^"|"$/g, '') },
        httpMetadata: { contentType }, customMetadata, md5: md5 ? Uint8Array.from(Buffer.from(md5, 'base64')).buffer : undefined
      });
      if (!object) throw new Error('R2 conditional fixture write failed');
    },
    async list() { throw new Error('Forecast fixture must not list objects'); },
    async delete() { throw new Error('Forecast fixture must not delete objects'); }
  };
}

it('builds and serves committed private UPP runs in both hemispheres', async ({ signal: testSignal, onTestFailed }) => {
  const startedAt = Date.now();
  let phase = 'load Wrangler', phaseStartedAt = startedAt;
  const completedPhases: Record<string, number> = {};
  const enterPhase = (next: string) => {
    const now = Date.now();
    completedPhases[phase] = now - phaseStartedAt;
    phase = next;
    phaseStartedAt = now;
  };
  onTestFailed(() => {
    const now = Date.now();
    console.error('WRF fixture timing', { phase, phaseMs: now - phaseStartedAt, totalMs: now - startedAt, completedPhases });
  });
  const { getPlatformProxy, unstable_dev } = await import('wrangler');
  const root = await mkdtemp(join(tmpdir(), 'av-upp-upstream-')), persistTo = join(root, 'r2');
  try {
    enterPhase('open R2 proxy');
    const proxy = await withWranglerDeadline(phase, getPlatformProxy<{ BUCKET: R2Bucket }>({ configPath: config,
      persist: { path: join(persistTo, 'v3') }, remoteBindings: false, envFiles: [] }), late => late.dispose());
    const pins = new Map<string, string>();
    try {
      const store = boundStorage(proxy.env.BUCKET);
      for (const { product: fixture, cycleHourUtc } of fixtureRuns) {
        testSignal.throwIfAborted();
        enterPhase(`prepare ${fixture.modelId}`);
        const todayCycle = new Date(startedAt).setUTCHours(cycleHourUtc, 0, 0, 0);
        const cycle = new Date(todayCycle > startedAt ? todayCycle - 86_400_000 : todayCycle).toISOString().replace('.000Z', 'Z');
        const out = join(root, fixture.modelId), bundled = join(out, 'bundled');
        const product = { ...fixture, coverageDir: relative(contractDir, bundled) };
        fixtureRegistry.set(product.modelId, product);
        await publishUppFixture(store, product, cycle);
        const provider = createIndexedGribProvider(product);
        const resolved = await provider.resolveRun!({ cacheDir: join(root, 'source'), store, signal: testSignal });
        expect(resolved.cycle).toBe(cycle);
        const mask = denseFixtureMask(product, product.grid);
        const nativeHash = await writeCoverage(out, mask, product);
        await cp(join(out, 'coverage', nativeHash), bundled, { recursive: true });
        const inputs = { product, provider, mask, out, store };
        const plan = await createBuildPlan({ ...inputs, cycle: resolved.cycle, sourcePin: resolved.sourcePin, signal: testSignal,
          wholeDomain: await syntheticWholeDomain(out, product) });
        await cp(join(out, 'coverage', plan.wholeDomain.fineCoverage.hash), join(bundled, 'fine'), { recursive: true });
        expect(plan.groups).toEqual([[1], [26]]);
        testSignal.throwIfAborted();
        await uploadForecastControlPlan(store, out, plan);
        const signal = forecastPlanSignal(plan, testSignal);
        for (const shard of [0, 1]) {
          enterPhase(`build ${fixture.modelId} shard ${shard}`);
          await completeForecastControlShard(store, plan, shard, join(out, 'shards', String(shard), 'receipt.json'),
            () => buildShard({ ...inputs, plan, shard, cacheDir: join(root, 'source'), signal }), signal);
        }
        enterPhase(`publish ${fixture.modelId}`);
        const assembly = join(root, product.modelId + '-publish');
        await mkdir(assembly);
        await cp(join(out, 'plan.json'), join(assembly, 'plan.json'));
        await cp(join(out, 'coverage'), join(assembly, 'coverage'), { recursive: true });
        await downloadForecastControlReceipts(store, assembly, plan, signal);
        const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'owner/repo', GITHUB_SHA: 'a'.repeat(40),
          GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/forecast.yml@refs/heads/main',
          GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: product.modelId });
        await finalizeBuild({ ...inputs, out: assembly, plan, signal, onValidated: async validated => {
          await publish(store, assembly, validated.manifest, { authority, validated, receiptsOnly: true, deadlineAt: plan.deadlineAt, signal });
        } });
        pins.set(product.modelId, plan.buildId);
      }
    } finally {
      enterPhase('close R2 proxy');
      await withWranglerDeadline(phase, proxy.dispose());
    }

    testSignal.throwIfAborted();
    enterPhase('start local Worker');
    const worker = await withWranglerDeadline(phase, unstable_dev(fileURLToPath(new URL('../apps/api/test/upp-fixture-worker.ts', import.meta.url)), {
      config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: true, persistTo,
      vars: { AV_LOCAL_DEVELOPMENT: 'true' }, envFiles: [], logLevel: 'error',
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false }
    }), late => late.stop());
    try {
      const origin = `http://${worker.address}:${worker.port}`;
      const read = async (path: string) => {
        const signal = AbortSignal.any([testSignal, AbortSignal.timeout(5_000)]);
        const response = await fetch(origin + path, { signal }).catch(error => {
          throw new Error(`WRF fixture request failed for ${path}`, { cause: error });
        });
        expect(response.status, response.ok ? path : await response.clone().text()).toBe(200);
        return response;
      };
      for (const { product } of fixtureRuns) {
        enterPhase(`probe ${product.modelId}`);
        const model = product.modelId, buildId = pins.get(model)!, endpoint = `/v1/models/${model}`;
        expect(await (await read(`${endpoint}/latest?expand=manifest`)).json()).toMatchObject({
          manifest: { buildId, version: 5, tool: { useStoredMslNoLift: true } }
        });
        const point = gridToGeographic(product.grid, 14, 8)!, query = `lat=${point.lat}&lon=${point.lon}&frame=f001`;
        const pinned = `${endpoint}/runs/${buildId}`;
        const sample = sampleResponseV5Schema.parse(await (await read(`${pinned}/sample?${query}&layers=precip-rate,usable-lift-msl,usable-lift-agl`)).json());
        expect(sample.frames[0]!.layers).toMatchObject({
          'precip-rate': { value: 2, status: 'valid', surfaceId: 'native' },
          'usable-lift-msl': { value: expect.closeTo(1253.8462, 2), status: 'valid', surfaceId: 'fine' },
          'usable-lift-agl': { value: expect.closeTo(1153.8462, 2), status: 'valid', surfaceId: 'fine' }
        });
        const profile = profileResponseSchema.parse(await (await read(`${pinned}/profile?${query}`)).json());
        expect(profile.cell?.index).toBe(8 * product.grid.width + 14);
        const column = profile.frames[0]!.profile;
        expect(column.modelTerrainM).toBe(100);
        expect(column.levels.map(level => level.pressureHpa)).toEqual([950, 900, 850]);
        const rotation = prepareGridGeometry(product.grid).rotationAndMetrics(point.lat, point.lon)!;
        const { east, north } = gridVectorToEarth(16, 11, rotation);
        const firstLevel = column.levels[0]!;
        expect(firstLevel.uWindMps).toBe(Math.round(east * 100) / 100);
        expect(firstLevel.vWindMps).toBe(Math.round(north * 100) / 100);
        const virtualTemperature = 286.15 * (1 + 0.61 * 0.007);
        const omega = -0.5 * 95_000 * 9.80665 / (287.05 * virtualTemperature);
        expect(Math.abs(firstLevel.omegaPaS! - omega)).toBeLessThan(0.051);
        const tile = await read(`/tiles/${model}/${buildId}/precip-rate/f001/0/0/0.webp`);
        expect(tile.headers.get('content-type')).toBe('image/webp');
        expect(Number(tile.headers.get('x-av-r2-reads'))).toBeGreaterThan(1);
        expect(Buffer.from(await tile.arrayBuffer()).subarray(8, 12).toString()).toBe('WEBP');
      }
      enterPhase('probe catalog');
      const catalog = await (await read('/v1/catalog')).json();
      expect(catalog).toMatchObject({ models: expect.arrayContaining(fixtureRuns.map(({ product }) => expect.objectContaining({ model: product.modelId, available: true }))) });
    } finally {
      enterPhase('stop local Worker');
      await withWranglerDeadline(phase, worker.stop());
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 90_000);
