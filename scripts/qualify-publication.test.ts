import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { GFS_GRID, GFS_PRODUCT, setBit, type CoverageMask } from '@av/contracts';
import { buildForecast } from '../apps/batch/src/build.js';
import { workflowAuthority } from '../apps/batch/src/authority.js';
import type { ForecastProvider } from '../apps/batch/src/providers.js';
import type { ObjectStorage } from '../apps/batch/src/storage.js';
import { normalizedFixtureFrame } from './fixtures/normalized-provider.js';
import { qualificationStore, qualifyPublication } from './qualify-publication.js';
import { validateLocalBuild } from '../apps/batch/src/local-build.js';

interface Stored { bytes: Uint8Array; etag: string; lastModified: Date }
class MemoryStore implements ObjectStorage {
  failDelete = false;
  constructor(readonly objects: Map<string, Stored>, readonly calls: string[]) {}
  async get(key: string, range?: { offset: number; length: number }, maxBytes = 256 * 1024 * 1024) {
    this.calls.push(key); const value = this.objects.get(key); if (!value) return null;
    const bytes = range ? value.bytes.slice(range.offset, range.offset + range.length) : value.bytes.slice();
    if (bytes.length > maxBytes) throw new Error('Read budget exceeded');
    return { bytes, etag: value.etag };
  }
  async head(key: string) { this.calls.push(key); const value = this.objects.get(key); return value ? { size: value.bytes.length, etag: value.etag } : null; }
  async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _contentType?: string, contentMd5?: string) {
    this.calls.push(key); const current = this.objects.get(key), md5 = createHash('md5').update(bytes).digest();
    if ((condition.ifNoneMatch && current) || (condition.ifMatch && current?.etag !== condition.ifMatch)) throw Object.assign(new Error('precondition failed'), { $metadata: { httpStatusCode: 412 } });
    if (contentMd5 && contentMd5 !== md5.toString('base64')) throw new Error('Content-MD5 mismatch');
    this.objects.set(key, { bytes: bytes.slice(), etag: `"${md5.toString('hex')}"`, lastModified: new Date() });
  }
  async list(prefix: string) { this.calls.push(prefix); return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, lastModified: value.lastModified })); }
  async delete(keys: string[]) { this.calls.push(...keys); if (this.failDelete) throw new Error('Injected DeleteObjects failure'); for (const key of keys) this.objects.delete(key); }
}

const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'Forecast maintenance', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
let root: string, manifestPath: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'av-publication-fixture-'));
  const cells = GFS_GRID.width * GFS_GRID.height;
  const mask: CoverageMask = { grid: GFS_GRID, bounds: GFS_PRODUCT.bounds, output: new Uint8Array(Math.ceil(cells / 8)), halo: new Uint8Array(Math.ceil(cells / 8)), tiles: new Uint8Array(2731), maxZoom: 7 };
  setBit(mask.output, 360 * GFS_GRID.width + 720); setBit(mask.tiles, 0); setBit(mask.tiles, (4 ** 7 - 1) / 3 + 64 * 128 + 64);
  const cycle = new Date(Math.floor(Date.now() / (6 * 3600000)) * 6 * 3600000).toISOString();
  const provider: ForecastProvider = { id: 'qualification-fixture', provider: 'fixture', maxLevels: 3, async open({ activeIndices }) {
    return { cycle, stats: {}, async acquire(hour) { const frame = normalizedFixtureFrame(GFS_GRID, activeIndices, cycle, hour, 3); frame.precipitationMmPerHour.fill(2); return frame; }, async close() {} };
  } };
  manifestPath = await buildForecast({ out: root, cycle, product: GFS_PRODUCT, mask, provider });
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('operator validate and smoke require exact local coverage and provenance', async () => {
  const { manifest } = await validateLocalBuild(manifestPath), execute = promisify(execFile);
  const cli = fileURLToPath(new URL('../apps/batch/src/cli.ts', import.meta.url)), smoke = fileURLToPath(new URL('./smoke-build.ts', import.meta.url));
  await execute(process.execPath, ['--import', 'tsx', cli, 'validate', '--manifest', manifestPath]);
  await execute(process.execPath, ['--import', 'tsx', smoke, '--manifest', manifestPath]);
  const output = join(root, 'coverage', manifest.coverage.hash, 'output.bin'), original = await readFile(output);
  try {
    const corrupt = Buffer.from(original); corrupt[0] ^= 1; await writeFile(output, corrupt);
    await expect(execute(process.execPath, ['--import', 'tsx', cli, 'validate', '--manifest', manifestPath])).rejects.toThrow('Coverage output bitset hash mismatch');
    await expect(execute(process.execPath, ['--import', 'tsx', smoke, '--manifest', manifestPath])).rejects.toThrow('Coverage output bitset hash mismatch');
    await rm(output);
    await expect(validateLocalBuild(manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await writeFile(output, original); }
  const provenance = join(root, manifest.source.provenanceKey), provenanceBytes = await readFile(provenance);
  try {
    await rm(provenance);
    await expect(execute(process.execPath, ['--import', 'tsx', cli, 'validate', '--manifest', manifestPath])).rejects.toThrow('provenance.json');
    await expect(execute(process.execPath, ['--import', 'tsx', smoke, '--manifest', manifestPath])).rejects.toThrow('provenance.json');
  } finally { await writeFile(provenance, provenanceBytes); }
}, 30_000);

it('runs the real publication/recovery algorithms and confines every remote operation to its nonce', async () => {
  const objects = new Map<string, Stored>(), calls: string[] = [], first = new MemoryStore(objects, calls), second = new MemoryStore(objects, calls);
  const live = Buffer.from('untouched live catalog');
  await first.put('catalog/gfs/latest.json', live, { ifNoneMatch: '*' }); calls.length = 0;
  const receipt = await qualifyPublication({ store: first, secondStore: second, root, manifestPath, authority, backend: 'memory', receiptPath: join(root, 'qualification.json') });
  expect(receipt.error).toBeUndefined(); expect(receipt.passed).toBe(true);
  expect(receipt.stages).toHaveLength(11);
  expect(receipt.stages.find(stage => stage.name === 'independent-writers-cas-conflict')?.outcome).toMatchObject({ attempts: [1, 1], conflictStatus: 412, originalRetained: true, intentionalSameCycleSuccessor: true });
  expect(receipt.stages.find(stage => stage.name === 'rollback-verifies-complete-build')?.outcome).toMatchObject({ verifiedPayloads: 28, allArtifactAndCoverageRangesObserved: true });
  expect(receipt.stages.at(-1)?.outcome).toMatchObject({ wallTimeAgedObjectProof: false, freshObjectProtected: true, protectedRetainedObjects: 54, losingUnretainedBuildDeleted: true });
  expect(receipt.cleanup).toMatchObject({ remainingObjects: 0, emptyProved: true });
  expect(calls.every(key => key.startsWith(receipt.namespace))).toBe(true);
  expect([...objects.keys()]).toEqual(['catalog/gfs/latest.json']);
  expect(objects.get('catalog/gfs/latest.json')!.bytes).toEqual(live);
  expect(JSON.parse(await readFile(join(root, 'qualification.json'), 'utf8')).passed).toBe(true);
}, 30_000);

it('reports failed cleanup and retains the exact namespace in its receipt', async () => {
  const objects = new Map<string, Stored>(), calls: string[] = [], store = new MemoryStore(objects, calls); store.failDelete = true;
  const receipt = await qualifyPublication({ store, secondStore: new MemoryStore(objects, calls), root, manifestPath, authority, backend: 'memory', receiptPath: join(root, 'qualification-delete-failure.json') });
  expect(receipt.passed).toBe(false); expect(receipt.cleanup).toMatchObject({ attempted: true, emptyProved: false, scope: receipt.namespace, error: 'Injected DeleteObjects failure' });
  expect(objects.size).toBeGreaterThan(0); expect([...objects.keys()].every(key => key.startsWith(receipt.namespace))).toBe(true);
}, 30_000);

it('rejects production authority and namespace escapes before storage calls', async () => {
  const objects = new Map<string, Stored>(), calls: string[] = [], store = new MemoryStore(objects, calls);
  const production = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'Forecast maintenance', GITHUB_RUN_ID: '123', TARGET_ENV: 'production', MODEL: 'gfs' });
  await expect(qualifyPublication({ store, secondStore: store, root, manifestPath, authority: production, backend: 'memory', receiptPath: join(root, 'never.json') })).rejects.toThrow('staging-only');
  const counts = { gets: 0, heads: 0, puts: 0, lists: 0, deleteCalls: 0, deletedKeys: 0, readBytes: 0, writtenBytes: 0 };
  const scoped = qualificationStore(store, '00000000-0000-4000-8000-000000000000', counts);
  await expect(scoped.delete(['../catalog/gfs/latest.json'])).rejects.toThrow('Unsafe');
  await expect(scoped.get('/catalog/gfs/latest.json')).rejects.toThrow('Unsafe');
  expect(calls).toEqual([]);
});

it('rejects a source revision mismatch before publishing downloaded artifacts', async () => {
  const objects = new Map<string, Stored>(), calls: string[] = [], store = new MemoryStore(objects, calls);
  const receipt = await qualifyPublication({ store, secondStore: store, root, manifestPath, authority, backend: 'memory', sourceRevision: '0'.repeat(40), receiptPath: join(root, 'qualification-source-failure.json') });
  expect(receipt.passed).toBe(false); expect(receipt.error).toContain('verified workflow artifact');
  expect(receipt.counters.puts).toBe(0); expect(receipt.cleanup.emptyProved).toBe(true); expect(objects.size).toBe(0);
});

it('does not delete a namespace that was not initially empty', async () => {
  const objects = new Map<string, Stored>(), calls: string[] = [], store = new MemoryStore(objects, calls), list = store.list.bind(store);
  store.list = async prefix => { objects.set(`${prefix}existing`, { bytes: Uint8Array.of(1), etag: 'existing', lastModified: new Date() }); return list(prefix); };
  const receipt = await qualifyPublication({ store, secondStore: store, root, manifestPath, authority, backend: 'memory', receiptPath: join(root, 'qualification-existing.json') });
  expect(receipt.passed).toBe(false); expect(receipt.error).toContain('already exists');
  expect(receipt.counters.deleteCalls).toBe(0); expect(receipt.cleanup).toMatchObject({ attempted: false, reason: 'namespace-not-claimed' });
  expect(objects.size).toBe(1);
});
