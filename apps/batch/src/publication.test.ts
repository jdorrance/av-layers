import { mkdtemp, mkdir, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GFS_GRID, GFS_PRODUCT, MAX_PROVENANCE_BYTES, LAYER_IDS, createProductDescriptors, createRecipeIdentity, type Manifest, type ModelPointer } from '@av/contracts';
import { workflowAuthority } from './authority.js';
import { putImmutable, uploadBounded } from './immutable-upload.js';
import { writeCoverage } from './coverage.js';
import type { ObjectStorage } from './storage.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock('./validate.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./validate.js')>();
  return { ...actual, wasValidatedInProcess: vi.fn(actual.wasValidatedInProcess), loadCoverage: vi.fn(async () => ({})), validateBuild: vi.fn(async (_root: string, manifest: Manifest) => manifest) };
});

import { buildIdTime, cleanup, MAX_UPLOAD_ARTIFACT_BYTES, publish, rollback, type CleanupSummary } from './publication.js';
import { localPath, sha256, validateBuild, wasValidatedInProcess } from './validate.js';

class MemoryStore implements ObjectStorage {
  objects = new Map<string, { bytes: Uint8Array; etag: string; lastModified: Date }>();
  failKey = '';
  beforePut?: (key: string) => void | Promise<void>;
  headOverride?: (key: string, result: { size: number; etag: string } | null) => { size: number; etag: string } | null;
  gets: Array<{ key: string; range?: { offset: number; length: number } }> = [];
  checksums: string[] = [];
  async get(key: string, range?: { offset: number; length: number }) {
    this.gets.push({ key, range });
    const object = this.objects.get(key);
    return object ? { bytes: range ? object.bytes.slice(range.offset, range.offset + range.length) : object.bytes.slice(), etag: object.etag } : null;
  }
  async head(key: string) {
    const object = this.objects.get(key);
    const result = object ? { size: object.bytes.length, etag: object.etag } : null;
    return this.headOverride ? this.headOverride(key, result) : result;
  }
  async put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, _contentType?: string, contentMd5?: string) {
    if (key === this.failKey) throw new Error('injected failure');
    await this.beforePut?.(key);
    const md5 = createHash('md5').update(bytes).digest();
    if (contentMd5) {
      this.checksums.push(contentMd5);
      if (contentMd5 !== md5.toString('base64')) throw new Error('bad Content-MD5');
    }
    const existing = this.objects.get(key);
    if ((condition.ifNoneMatch && existing) || (condition.ifMatch && existing?.etag !== condition.ifMatch)) throw new Error('precondition failed');
    this.objects.set(key, { bytes: bytes.slice(), etag: `"${md5.toString('hex')}"`, lastModified: new Date() });
  }
  async list(prefix: string): ReturnType<ObjectStorage['list']> { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, lastModified: value.lastModified, size: value.bytes.length })); }
  async delete(keys: string[]) { for (const key of keys) this.objects.delete(key); }
}

const authority = workflowAuthority({ GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_WORKFLOW: 'Forecast sample', GITHUB_RUN_ID: '123', TARGET_ENV: 'staging', MODEL: 'gfs' });
const now = Date.parse('2026-10-30T06:01:00.000Z');
const id = '20261030T060000Z-12345678-1234-4234-8234-123456789abc';
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; manifest: Manifest }> {
  const root = await mkdtemp(join(tmpdir(), 'av-publish-test-')); temp.push(root);
  const bytes = Buffer.from('test artifact contents long enough to exercise a 32-byte tail range'.padEnd(120, '.')), hash = sha256(bytes), prefix = `builds/gfs/${id}`;
  const frames = Array.from({ length: 8 }, (_, i) => ({ id: `f${String((i + 1) * 3).padStart(3, '0')}`, validTime: new Date(Date.parse('2026-10-30T00:00:00.000Z') + (i + 1) * 10800000).toISOString(), intervalStart: new Date(Date.parse('2026-10-30T00:00:00.000Z') + i * 10800000).toISOString(), intervalEnd: new Date(Date.parse('2026-10-30T00:00:00.000Z') + (i + 1) * 10800000).toISOString() }));
  const artifacts = LAYER_IDS.flatMap(layer => frames.map(frame => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: hash })));
  for (const key of [...artifacts.map(a => a.tilesKey), `${prefix}/samples.bin`]) { const path = localPath(root, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  const coverageHash = await writeCoverage(root, { grid: GFS_GRID, bounds: GFS_PRODUCT.bounds, output: new Uint8Array(129780), halo: new Uint8Array(129780), tiles: new Uint8Array(2731), maxZoom: 7 }, GFS_PRODUCT);
  const manifest: Manifest = { version: 3, descriptors: createProductDescriptors(), recipe: createRecipeIdentity(GFS_PRODUCT, hash), model: 'gfs', buildId: id, cycle: '2026-10-30T00:00:00.000Z', createdAt: '2026-10-30T06:00:00.000Z', expiresAt: '2026-11-06T06:00:00.000Z', method: { id: 'test', hash }, coverage: { id: GFS_PRODUCT.coverageId, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom: 7 }, grid: GFS_GRID, frames, layers: [...LAYER_IDS], artifacts, samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 1, channelCount: 24, bytes: 120, key: `${prefix}/samples.bin`, sha256: hash }, source: { provider: 'NOAA', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash }, tool: {}, palettes: ['lift'], metrics: {} };
  {
    const provenanceKey = `${prefix}/provenance.json`, receipt = Buffer.from(JSON.stringify({ version: 1, model: manifest.model, buildId: id, cycle: manifest.cycle, frames: [{ hour: 3 }] }));
    await writeFile(localPath(root, provenanceKey), receipt);
    manifest.source = { provider: 'NOAA', provenanceKey, provenanceSha256: sha256(receipt) };
  }
  return { root, manifest };
}

describe('immutable publication', () => {
  it('stops existing-object verification between bounded ranges when cancelled', async () => {
    const store = new MemoryStore(), bytes = new Uint8Array(8 * 1024 * 1024), signal = new AbortController();
    await store.put('existing', bytes, { ifNoneMatch: '*' });
    const get = store.get.bind(store);
    store.get = async (...args) => { const result = await get(...args); signal.abort(new Error('cancelled proof')); return result; };
    await expect(putImmutable(store, 'existing', bytes, 'application/octet-stream', signal.signal)).rejects.toThrow('cancelled proof');
    expect(store.gets).toHaveLength(1);
  });

  it('rejects same-size corrupted existing bytes even when the reported ETag is unchanged', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const pointer = store.objects.get('catalog/gfs/latest.json')!.bytes.slice();
    store.objects.get(manifest.artifacts[0].tilesKey)!.bytes[60] ^= 1;
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('Immutable object hash mismatch');
    expect(store.objects.get('catalog/gfs/latest.json')!.bytes).toEqual(pointer);
  });

  it('rejects local growth after upload reservations before allocating or publishing it', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const path = localPath(root, manifest.artifacts[0].tilesKey);
    let changed = false;
    store.beforePut = async key => {
      if (!changed && key.startsWith('coverage/')) { changed = true; await truncate(path, MAX_UPLOAD_ARTIFACT_BYTES + 1); }
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('byte budget');
    expect(store.objects.has(manifest.artifacts[0].tilesKey)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });

  it('resumes a partial upload and proves existing objects without rewriting them', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    store.failKey = manifest.artifacts[2].tilesKey;
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('injected');
    const existing = new Set(store.objects.keys()), writes: string[] = [];
    store.failKey = ''; store.beforePut = key => { writes.push(key); };
    await publish(store, root, manifest, { authority, now: () => now });
    expect(writes.every(key => !existing.has(key))).toBe(true);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(true);
  });
  it.each(['artifact', 'pointer'])('reconciles an ambiguous successful %s write', async target => {
    const { root, manifest } = await fixture(), store = new MemoryStore(), put = store.put.bind(store);
    const key = target === 'pointer' ? 'catalog/gfs/latest.json' : manifest.artifacts[0].tilesKey;
    let once = true;
    store.put = async (...args) => { await put(...args); if (args[0] === key && once) { once = false; throw new Error('connection lost after commit'); } };
    await publish(store, root, manifest, { authority, now: () => now });
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(true);
  });
  it('cancels before pointer commit and resumes the same immutable build', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore(), controller = new AbortController();
    store.beforePut = key => { if (key === `builds/gfs/${id}/manifest.json`) controller.abort(new Error('cancelled')); };
    await expect(publish(store, root, manifest, { authority, now: () => now, signal: controller.signal })).rejects.toThrow('cancelled');
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
    store.beforePut = undefined;
    await publish(store, root, manifest, { authority, now: () => now });
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(true);
  });
  it('bounds resident upload bytes independently of the file count', async () => {
    let active = 0, peak = 0;
    await uploadBounded([{ size: 9 }, { size: 8 }, { size: 2 }, { size: 3 }], 20, async item => {
      active += item.size * 2; peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active -= item.size * 2;
    });
    expect(peak).toBeLessThanOrEqual(20);
    expect(active).toBe(0);
  });
  it.each(['old cycle', 'short horizon'])('refuses latest promotion with %s before writes', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    if (defect === 'old cycle') manifest.cycle = '2026-10-29T00:00:00.000Z';
    else manifest.frames = manifest.frames.map(frame => ({ ...frame, validTime: new Date(now + 3600000).toISOString() }));
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('useful forecast horizon');
    expect(store.objects.size).toBe(0);
  });
  it.each([0, MAX_UPLOAD_ARTIFACT_BYTES + 1])('rejects a %i-byte artifact before reading it for upload', async size => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const path = localPath(root, manifest.artifacts[0].tilesKey);
    await truncate(path, size);
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('per-file upload limit');
    expect(vi.mocked(readFile).mock.calls.some(([file]) => file === path)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('reuses a process-local validation result but still checks the actual uploaded bytes', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const checks = vi.mocked(validateBuild).mock.calls.length;
    vi.mocked(wasValidatedInProcess).mockReturnValueOnce(true);
    await publish(store, root, manifest, { authority, now: () => now });
    expect(vi.mocked(validateBuild).mock.calls.length).toBe(checks);
    const nextStore = new MemoryStore();
    await writeFile(localPath(root, manifest.samples.key), 'changed after validation');
    vi.mocked(wasValidatedInProcess).mockReturnValueOnce(true);
    await expect(publish(nextStore, root, manifest, { authority, now: () => now })).rejects.toThrow('Local hash mismatch');
    expect(nextStore.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('publishes verified external provenance before the manifest and latest pointer', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const writes: string[] = [];
    store.beforePut = key => { writes.push(key); };
    await publish(store, root, manifest, { authority, now: () => now });
    const key = manifest.source.provenanceKey as string;
    expect(sha256(store.objects.get(key)!.bytes)).toBe(manifest.source.provenanceSha256);
    expect(store.gets).toContainEqual({ key, range: undefined });
    expect(writes.slice(-3)).toEqual([key, `builds/gfs/${id}/manifest.json`, 'catalog/gfs/latest.json']);
  });
  it.each(['missing', 'corrupt'])('rejects %s provenance readback before committing a publication', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const get = store.get.bind(store);
    store.get = async (key, range) => {
      const result = await get(key, range);
      if (key !== manifest.source.provenanceKey || range) return result;
      return defect === 'missing' ? null : { bytes: Buffer.from('corrupt receipt'), etag: 'corrupt' };
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('Provenance readback mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('rejects a partial provenance reference before uploading any objects', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    Reflect.deleteProperty(manifest.source, 'provenanceSha256');
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow(/provenance/i);
    expect(store.objects.size).toBe(0);
  });
  it.each(['wrong cycle', 'wrong schema'])('does not commit a hash-matching %s provenance receipt', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const receipt = Buffer.from(JSON.stringify({ version: defect === 'wrong schema' ? 2 : 1, model: manifest.model, buildId: manifest.buildId, cycle: defect === 'wrong cycle' ? '2026-10-29T00:00:00.000Z' : manifest.cycle, frames: [] }));
    manifest.source.provenanceSha256 = sha256(receipt);
    await writeFile(localPath(root, manifest.source.provenanceKey as string), receipt);
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow(/provenance|version/i);
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('publishes only after artifact and manifest verification', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe(id);
    expect(store.objects.size).toBe(32);
    expect(store.checksums).toHaveLength(31);
    const artifactGets = store.gets.filter(call => call.key.startsWith(`builds/gfs/${id}/`) && !call.key.endsWith('/manifest.json') && !call.key.endsWith('/provenance.json'));
    expect(artifactGets).toHaveLength(25);
    expect(artifactGets.every(call => call.range?.length === 32)).toBe(true);
    await expect(publish(store, root, manifest, { authority, now: () => now })).resolves.toBeUndefined();
  });
  it.each(['missing', 'size', 'hash', 'opaque', 'multipart'])('rejects %s artifact metadata without committing', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    store.headOverride = (_key, result) => {
      if (defect === 'missing') return null;
      if (!result) return null;
      if (defect === 'size') return { ...result, size: result.size + 1 };
      if (defect === 'hash') return { ...result, etag: '"00000000000000000000000000000000"' };
      if (defect === 'multipart') return { ...result, etag: `${result.etag.slice(0, -1)}-2"` };
      return { ...result, etag: 'opaque' };
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('single-PUT MD5 ETag or size mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('bounds concurrent files to four and validates byte bodies', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    let active = 0, maximum = 0, started = 0;
    let release!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const four = new Promise<void>(resolve => { ready = resolve; });
    store.beforePut = async key => {
      if (!key.startsWith('builds/') || (!key.endsWith('.bin') && !key.endsWith('.pmtiles'))) return;
      active++; maximum = Math.max(maximum, active);
      if (++started === 4) ready();
      await gate;
      active--;
    };
    const result = publish(store, root, manifest, { authority, now: () => now });
    await four;
    expect(started).toBe(4);
    release();
    await result;
    expect(maximum).toBe(4);
    expect(store.checksums).toHaveLength(31);
  });
  it('drains active uploads after failure without admitting more files or committing', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const prior: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'previous', retained: [{ buildId: 'previous', manifestKey: 'previous', cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(prior)), { ifNoneMatch: '*' });
    let started = 0, settled = 0, release!: () => void, fail!: () => void, ready!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const failGate = new Promise<void>(resolve => { fail = resolve; });
    const four = new Promise<void>(resolve => { ready = resolve; });
    store.beforePut = async key => {
      if (!key.startsWith('builds/') || (!key.endsWith('.bin') && !key.endsWith('.pmtiles'))) return;
      const index = ++started;
      if (started === 4) ready();
      await (index === 1 ? failGate : gate);
      settled++;
      if (index === 1) throw new Error('pool failure');
    };
    const result = publish(store, root, manifest, { authority, now: () => now });
    let completed = false;
    void result.then(() => { completed = true; }, () => { completed = true; });
    const rejection = expect(result).rejects.toThrow('pool failure');
    await four;
    fail();
    await new Promise(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(started).toBe(4);
    release();
    await rejection;
    expect(started).toBe(4);
    expect(settled).toBe(4);
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString())).toEqual(prior);
  });
  it('rejects a locally corrupted body before uploading it', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const key = manifest.artifacts[0].tilesKey;
    await writeFile(localPath(root, key), Buffer.from('corrupted bytes'));
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('Local hash mismatch');
    expect(store.objects.has(key)).toBe(false);
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
  });
  it('rejects a body corrupted in transit using Content-MD5', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const put = store.put.bind(store);
    store.put = async (key, bytes, condition, contentType, contentMd5) => {
      const body = bytes.slice();
      if (contentMd5) body[0] ^= 1;
      await put(key, body, condition, contentType, contentMd5);
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('bad Content-MD5');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('rejects a mismatching tail even with matching metadata', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const get = store.get.bind(store);
    store.get = async (key, range) => {
      const object = await get(key, range);
      return object && range ? { ...object, bytes: new Uint8Array(range.length) } : object;
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('tail or ETag mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('rejects an interior change when R2 reports its recomputed single-PUT MD5 ETag', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const put = store.put.bind(store), target = manifest.artifacts[0].tilesKey;
    store.put = async (key, bytes, condition, contentType, contentMd5) => {
      await put(key, bytes, condition, contentType, contentMd5);
      if (key === target) {
        const object = store.objects.get(key)!;
        const originalTail = object.bytes.slice(-32);
        object.bytes[0] ^= 1;
        expect(object.bytes.slice(-32)).toEqual(originalTail);
        object.etag = `"${createHash('md5').update(object.bytes).digest('hex')}"`;
      }
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('single-PUT MD5 ETag or size mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('rejects an object changed between HEAD and tail even when the tail is unchanged', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const get = store.get.bind(store), target = manifest.artifacts[0].tilesKey;
    store.get = async (key, range) => {
      if (key === target && range) {
        const object = store.objects.get(key)!;
        object.bytes[0] ^= 1;
        object.etag = `"${createHash('md5').update(object.bytes).digest('hex')}"`;
      }
      return get(key, range);
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('tail or ETag mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('rejects a tail response with a different ETag even when its bytes match', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const get = store.get.bind(store);
    store.get = async (key, range) => {
      const object = await get(key, range);
      return object && range ? { ...object, etag: '"00000000000000000000000000000000"' } : object;
    };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('tail or ETag mismatch');
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('cannot detect interior corruption when a dishonest backend returns a stale MD5 ETag', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const put = store.put.bind(store), target = manifest.artifacts[0].tilesKey;
    store.put = async (key, bytes, condition, contentType, contentMd5) => {
      await put(key, bytes, condition, contentType, contentMd5);
      if (key === target) store.objects.get(key)!.bytes[0] ^= 1;
    };
    await publish(store, root, manifest, { authority, now: () => now });
    const object = store.objects.get(target)!;
    expect(object.etag).not.toBe(`"${createHash('md5').update(object.bytes).digest('hex')}"`);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(true);
  });
  it('does not publish after uploads exceed the lifetime', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    let clock = now, started = 0;
    store.beforePut = key => {
      if (key.endsWith('.bin') || key.endsWith('.pmtiles')) {
        started++;
        clock = buildIdTime(id) + 6 * 3600000 + 1;
      }
    };
    await expect(publish(store, root, manifest, { authority, now: () => clock })).rejects.toThrow('lifetime');
    expect(started).toBeLessThanOrEqual(4);
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('leaves pointer untouched after interrupted upload and rejects expired IDs', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    store.failKey = manifest.artifacts[2].tilesKey;
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('injected');
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
    await expect(publish(store, root, manifest, { authority, now: () => now + 7 * 3600000 })).rejects.toThrow('lifetime');
    expect(buildIdTime(id)).toBe(now - 60000);
  });
  it('does not admit a losing create-only CAS after a competing first publication', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const winner: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'winner', retained: [{ buildId: 'winner', manifestKey: 'winner', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    store.beforePut = key => { if (key === 'catalog/gfs/latest.json') store.objects.set(key, { bytes: Buffer.from(JSON.stringify(winner)), etag: 'winner-etag', lastModified: new Date(now) }); };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('precondition failed');
    expect(await store.get(`builds/gfs/${id}/manifest.json`)).not.toBeNull();
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe('winner');
  });
  it('does not overwrite a concurrent pointer update with stale If-Match', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const entry = { buildId: 'previous', manifestKey: 'previous', cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: 'previous', retained: [entry] })), { ifNoneMatch: '*' });
    store.beforePut = key => { if (key === 'catalog/gfs/latest.json') store.objects.set(key, { bytes: Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: 'winner', retained: [{ ...entry, buildId: 'winner' }] })), etag: 'new-etag', lastModified: new Date(now) }); };
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('precondition failed');
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe('winner');
  });
  it('requires an unexpired retained rollback and protects retained and fresh objects during cleanup', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    expect(() => workflowAuthority({})).toThrow('serialized');
    await rollback(store, 'gfs', id, authority, now);
    await expect(rollback(store, 'gfs', id, authority, Date.parse(manifest.expiresAt))).rejects.toThrow('not retained');
    const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc', fresh = '20261030T053000Z-12345678-1234-4234-8234-123456789abc';
    await store.put(`builds/gfs/${stale}/part`, Buffer.from('x'), { ifNoneMatch: '*' });
    await store.put(`builds/gfs/${fresh}/part`, Buffer.from('x'), { ifNoneMatch: '*' });
    store.objects.get(`builds/gfs/${stale}/part`)!.lastModified = new Date(now - 2 * 86400000);
    expect(await cleanup(store, 'gfs', authority, now)).toBe(1);
    expect(await store.get(`builds/gfs/${fresh}/part`)).not.toBeNull();
    expect(await store.get(`builds/gfs/${id}/manifest.json`)).not.toBeNull();
  });
  it('rolls back a complete build with mandatory external provenance', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const pointerObject = store.objects.get('catalog/gfs/latest.json')!;
    const pointer = JSON.parse(Buffer.from(pointerObject.bytes).toString()) as ModelPointer;
    pointer.retained.push({ ...pointer.retained[0], buildId: 'current', manifestKey: 'current' });
    pointer.latestBuildId = 'current';
    pointerObject.bytes = Buffer.from(JSON.stringify(pointer));
    store.gets = [];
    await rollback(store, 'gfs', id, authority, now);
    expect(JSON.parse(Buffer.from(store.objects.get('catalog/gfs/latest.json')!.bytes).toString()).latestBuildId).toBe(id);
    expect(store.gets.some(call => call.key.endsWith('/provenance.json'))).toBe(true);
    expect(store.gets.some(call => call.key.endsWith('/output.bin') && !!call.range)).toBe(true);
  });
  it.each(['missing descriptor', 'corrupt descriptor', 'missing output', 'corrupt output', 'missing halo', 'corrupt halo', 'missing tiles', 'corrupt tiles'])('preserves latest when rollback coverage has %s', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const name = defect.split(' ')[1], key = name === 'descriptor' ? manifest.coverage.maskKey : `coverage/${manifest.coverage.hash}/${name}.bin`;
    if (defect.startsWith('missing')) store.objects.delete(key);
    else store.objects.get(key)!.bytes[0] ^= 1;
    const pointer = store.objects.get('catalog/gfs/latest.json')!.bytes.slice(), writes: string[] = [];
    store.beforePut = key => { writes.push(key); };
    await expect(rollback(store, 'gfs', id, authority, now)).rejects.toThrow(/coverage|Rollback object/);
    expect(writes).toEqual([]);
    expect(store.objects.get('catalog/gfs/latest.json')!.bytes).toEqual(pointer);
  });

  it('reconciles a rollback pointer timeout after a successful compare-and-swap', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const put = store.put.bind(store);
    store.put = async (...args) => { await put(...args); if (args[0] === 'catalog/gfs/latest.json') throw new Error('timeout after commit'); };
    await expect(rollback(store, 'gfs', id, authority, now)).resolves.toBeUndefined();
    expect(JSON.parse(Buffer.from(store.objects.get('catalog/gfs/latest.json')!.bytes).toString()).latestBuildId).toBe(id);
  });
  it.each(['missing', 'corrupt', 'missing key', 'missing hash', 'wrong key', 'invalid hash', 'wrong cycle', 'wrong model', 'wrong build', 'wrong schema'])('does not change latest when rollback provenance is %s', async defect => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const provenanceKey = manifest.source.provenanceKey as string;
    if (defect === 'missing') store.objects.delete(provenanceKey);
    else if (defect === 'corrupt') store.objects.get(provenanceKey)!.bytes = Buffer.from('corrupt receipt');
    else {
      if (defect === 'missing key') Reflect.deleteProperty(manifest.source, 'provenanceKey');
      if (defect === 'missing hash') Reflect.deleteProperty(manifest.source, 'provenanceSha256');
      if (defect === 'wrong key') manifest.source.provenanceKey = 'builds/gfs/another/provenance.json';
      if (defect === 'invalid hash') manifest.source.provenanceSha256 = 'invalid';
      if (['wrong cycle', 'wrong model', 'wrong build', 'wrong schema'].includes(defect)) {
        const receipt = Buffer.from(JSON.stringify({ version: defect === 'wrong schema' ? 2 : 1, model: defect === 'wrong model' ? 'hrrr' : manifest.model, buildId: defect === 'wrong build' ? 'another' : manifest.buildId, cycle: defect === 'wrong cycle' ? '2026-10-29T00:00:00.000Z' : manifest.cycle, frames: [] }));
        store.objects.get(provenanceKey)!.bytes = receipt;
        manifest.source.provenanceSha256 = sha256(receipt);
      }
      store.objects.get(`builds/gfs/${id}/manifest.json`)!.bytes = Buffer.from(JSON.stringify(manifest));
    }
    const pointerObject = store.objects.get('catalog/gfs/latest.json')!;
    const pointer = JSON.parse(Buffer.from(pointerObject.bytes).toString()) as ModelPointer;
    pointer.retained.push({ ...pointer.retained[0], buildId: 'current', manifestKey: 'current' });
    pointer.latestBuildId = 'current';
    pointerObject.bytes = Buffer.from(JSON.stringify(pointer));
    const before = pointerObject.bytes.slice();
    const writes: string[] = [];
    store.beforePut = key => { writes.push(key); };
    await expect(rollback(store, 'gfs', id, authority, now)).rejects.toThrow(/provenance|version/i);
    expect(writes).toEqual([]);
    expect(store.objects.get('catalog/gfs/latest.json')!.bytes).toEqual(before);
  });
  it('rejects older and same-cycle replacement without intent', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'existing', retained: [{ buildId: 'existing', manifestKey: 'existing', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('Same-cycle');
    pointer.retained[0].cycle = '2026-10-30T06:00:00.000Z';
    store.objects.delete('catalog/gfs/latest.json');
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { authority, now: () => now, allowSameCycle: true })).rejects.toThrow('Older cycle');
  });
  it('admits a same-cycle replacement only with explicit intent', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'existing', retained: [{ buildId: 'existing', manifestKey: 'existing', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await publish(store, root, manifest, { authority, now: () => now, allowSameCycle: true });
    const result = JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString());
    expect(result.latestBuildId).toBe(id);
    expect(result.retained).toHaveLength(2);
  });
  it('does not allow a rollback to bypass the highest retained cycle', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'older', retained: [{ buildId: 'older', manifestKey: 'older', cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt }, { buildId: 'newer', manifestKey: 'newer', cycle: '2026-10-30T06:00:00.000Z', expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('Older cycle');
  });
  it('refuses a missing local artifact and does not commit', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await rm(localPath(root, manifest.samples.key));
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow();
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
  });
  it('checks the six-hour deadline again before committing the pointer', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    let clock = now;
    store.beforePut = key => { if (key.endsWith('/manifest.json')) clock = buildIdTime(id) + 6 * 3600000 + 1; };
    await expect(publish(store, root, manifest, { authority, now: () => clock })).rejects.toThrow('lifetime');
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
  });
  it('refuses to evict an unexpired retained build when full', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const retained = Array.from({ length: 256 }, (_, i) => ({ buildId: `existing-${i}`, manifestKey: `existing-${i}`, cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt }));
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: retained[0].buildId, retained })), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow('limit');
    expect(store.objects.size).toBe(1);
  });
  it('protects a stale build prefix containing a recently modified object', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { authority, now: () => now });
    const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc';
    await store.put(`builds/gfs/${stale}/old`, Buffer.from('x'), { ifNoneMatch: '*' });
    await store.put(`builds/gfs/${stale}/new`, Buffer.from('x'), { ifNoneMatch: '*' });
    store.objects.get(`builds/gfs/${stale}/old`)!.lastModified = new Date(now - 2 * 86400000);
    store.objects.get(`builds/gfs/${stale}/new`)!.lastModified = new Date(now - 1000);
    expect(await cleanup(store, 'gfs', authority, now)).toBe(0);
  });
});


it('refuses unservable provenance bytes or structure before committing a manifest or pointer', async () => {
  for (const receipt of [{ padding: 'x'.repeat(MAX_PROVENANCE_BYTES) }, { fields: Array(257).fill(0) }]) {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const bytes = Buffer.from(JSON.stringify({ version: 1, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle, frames: [receipt] }));
    await writeFile(localPath(root, manifest.source.provenanceKey), bytes);
    manifest.source.provenanceSha256 = sha256(bytes);
    await expect(publish(store, root, manifest, { authority, now: () => now })).rejects.toThrow(/budget|limit|large/);
    expect(store.objects.has(`builds/gfs/${manifest.buildId}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  }
});


it('reports protected and orphan costs without treating missing object sizes as zero', async () => {
  const { root, manifest } = await fixture(), store = new MemoryStore();
  await publish(store, root, manifest, { authority, now: () => now });
  const protectedObjects = await store.list('builds/gfs/');
  const protectedBytes = protectedObjects.reduce((sum, item) => sum + item.size!, 0);
  const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc', fresh = '20261030T053000Z-12345678-1234-4234-8234-123456789abc';
  for (const [key, bytes] of [[`builds/gfs/${stale}/known`, 'abc'], [`builds/gfs/${stale}/unknown`, 'four'], [`builds/gfs/${fresh}/part`, 'fresh']]) {
    await store.put(key, Buffer.from(bytes), { ifNoneMatch: '*' });
    if (key.includes(stale)) store.objects.get(key)!.lastModified = new Date(now - 2 * 86400000);
  }
  const list = store.list.bind(store);
  store.list = async prefix => (await list(prefix)).map(item => item.key.endsWith('/unknown') ? { key: item.key, lastModified: item.lastModified } : item);
  let summary: CleanupSummary | undefined;
  expect(await cleanup(store, 'gfs', authority, now, report => { summary = report; })).toBe(2);
  expect(summary).toMatchObject({ status: 'complete', prefix: 'builds/gfs/',
    listed: { objects: protectedObjects.length + 3, knownBytes: protectedBytes + 8, unknownSizeObjects: 1 },
    protected: { objects: protectedObjects.length, knownBytes: protectedBytes, unknownSizeObjects: 0 },
    unreferenced: { objects: 3, knownBytes: 8, unknownSizeObjects: 1 },
    eligible: { objects: 2, knownBytes: 3, unknownSizeObjects: 1 },
    deleted: { objects: 2, knownBytes: 3, unknownSizeObjects: 1 }
  });
  expect(await store.get(`builds/gfs/${fresh}/part`)).not.toBeNull();
});

it('reports unknown deletion progress after partial provider failure and unknown costs after listing failure', async () => {
  const { root, manifest } = await fixture(), store = new MemoryStore();
  await publish(store, root, manifest, { authority, now: () => now });
  const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc';
  for (const name of ['one', 'two']) { const key = `builds/gfs/${stale}/${name}`; await store.put(key, Buffer.from('x'), { ifNoneMatch: '*' }); store.objects.get(key)!.lastModified = new Date(now - 2 * 86400000); }
  const remove = store.delete.bind(store);
  store.delete = async keys => { await remove(keys.slice(0, 1)); throw new Error('partial provider failure'); };
  let summary: CleanupSummary | undefined;
  await expect(cleanup(store, 'gfs', authority, now, report => { summary = report; })).rejects.toThrow('partial provider');
  expect(summary).toMatchObject({ status: 'failed', eligible: { objects: 2, knownBytes: 2 }, deleted: null });
  store.list = async () => { throw new Error('listing unavailable'); };
  await expect(cleanup(store, 'gfs', authority, now, report => { summary = report; })).rejects.toThrow('listing unavailable');
  expect(summary).toMatchObject({ status: 'failed', listed: null, protected: null, unreferenced: null, eligible: null, deleted: { objects: 0, knownBytes: 0, unknownSizeObjects: 0 } });
});

it('cancels rollback verification before any pointer write', async () => {
  const { root, manifest } = await fixture(), store = new MemoryStore(), controller = new AbortController();
  await publish(store, root, manifest, { authority, now: () => now });
  const before = store.objects.get('catalog/gfs/latest.json')!.bytes.slice(), get = store.get.bind(store), outcomes: string[] = [];
  store.get = async (...args) => { const result = await get(...args); if (args[0].endsWith('/output.bin')) controller.abort(new Error('cancel verification')); return result; };
  const put = vi.spyOn(store, 'put');
  await expect(rollback(store, 'gfs', id, authority, now, { signal: controller.signal, onPointerOutcome: outcome => outcomes.push(outcome) })).rejects.toThrow('cancel verification');
  expect(put).not.toHaveBeenCalled(); expect(outcomes).toEqual([]);
  expect(store.objects.get('catalog/gfs/latest.json')!.bytes).toEqual(before);
});
it.each([false, true])('confirms rollback committed during cancellation, including lost response=%s', async lostResponse => {
  const { root, manifest } = await fixture(), store = new MemoryStore(), controller = new AbortController(), outcomes: string[] = [];
  await publish(store, root, manifest, { authority, now: () => now });
  const put = store.put.bind(store);
  store.put = async (...args) => { await put(...args); controller.abort(new Error('cancel after CAS')); if (lostResponse) throw new Error('lost CAS response'); };
  await expect(rollback(store, 'gfs', id, authority, now, { signal: controller.signal, onPointerOutcome: outcome => outcomes.push(outcome) })).resolves.toBeUndefined();
  expect(outcomes).toEqual(['unconfirmed', 'confirmed']);
});
it('keeps rollback unconfirmed when CAS response and authoritative reconciliation both fail', async () => {
  const { root, manifest } = await fixture(), store = new MemoryStore(), controller = new AbortController(), outcomes: string[] = [];
  await publish(store, root, manifest, { authority, now: () => now });
  const put = store.put.bind(store), get = store.get.bind(store); let attempted = false;
  store.put = async (...args) => { await put(...args); attempted = true; controller.abort(); throw new Error('lost CAS response'); };
  store.get = async (...args) => { if (attempted && args[0] === 'catalog/gfs/latest.json') throw new Error('authority unavailable'); return get(...args); };
  await expect(rollback(store, 'gfs', id, authority, now, { signal: controller.signal, onPointerOutcome: outcome => outcomes.push(outcome) })).rejects.toThrow('authority unavailable');
  expect(outcomes).toEqual(['unconfirmed']);
});
it('cancels cleanup after listing without deleting objects', async () => {
  const { root, manifest } = await fixture(), store = new MemoryStore(), controller = new AbortController();
  await publish(store, root, manifest, { authority, now: () => now });
  const list = store.list.bind(store), deleted = vi.spyOn(store, 'delete'); let summary: CleanupSummary | undefined;
  store.list = async (...args) => { const result = await list(...args); controller.abort(new Error('cancel listing')); return result; };
  await expect(cleanup(store, 'gfs', authority, now, value => { summary = value; }, controller.signal)).rejects.toThrow('cancel listing');
  expect(deleted).not.toHaveBeenCalled(); expect(summary).toMatchObject({ status: 'failed', deleted: { objects: 0 } });
});
