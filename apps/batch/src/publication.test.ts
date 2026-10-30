import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GFS_GRID, LAYER_IDS, type Manifest, type ModelPointer } from '@av/contracts';
import type { ObjectStorage } from './storage.js';

vi.mock('./validate.js', async importOriginal => ({ ...await importOriginal<typeof import('./validate.js')>(), loadCoverage: vi.fn(async () => ({})), validateBuild: vi.fn(async (_root: string, manifest: Manifest) => manifest) }));

import { buildIdTime, cleanup, publish, rollback } from './publication.js';
import { localPath, sha256 } from './validate.js';

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
  async list(prefix: string) { return [...this.objects].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, lastModified: value.lastModified })); }
  async delete(keys: string[]) { for (const key of keys) this.objects.delete(key); }
}

const now = Date.parse('2026-10-30T06:01:00.000Z');
const id = '20261030T060000Z-12345678-1234-4234-8234-123456789abc';
const temp: string[] = [];
afterEach(async () => { await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(): Promise<{ root: string; manifest: Manifest }> {
  const root = await mkdtemp(join(tmpdir(), 'av-publish-test-')); temp.push(root);
  const bytes = Buffer.from('test artifact contents long enough to exercise a 32-byte tail range'), hash = sha256(bytes), prefix = `builds/gfs/${id}`;
  const frames = Array.from({ length: 8 }, (_, i) => ({ id: `f${String((i + 1) * 3).padStart(3, '0')}`, validTime: new Date(Date.parse('2026-10-30T00:00:00.000Z') + (i + 1) * 10800000).toISOString(), intervalStart: new Date(Date.parse('2026-10-30T00:00:00.000Z') + i * 10800000).toISOString(), intervalEnd: new Date(Date.parse('2026-10-30T00:00:00.000Z') + (i + 1) * 10800000).toISOString() }));
  const artifacts = LAYER_IDS.flatMap(layer => frames.map(frame => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, samplesKey: `${prefix}/samples/${layer}/${frame.id}.bin`, tilesSha256: hash, samplesSha256: hash })));
  for (const artifact of artifacts) for (const key of [artifact.tilesKey, artifact.samplesKey]) { const path = localPath(root, key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  return { root, manifest: { version: 1, model: 'gfs', buildId: id, cycle: '2026-10-30T00:00:00.000Z', createdAt: '2026-10-30T06:00:00.000Z', expiresAt: '2026-11-06T06:00:00.000Z', method: { id: 'test', hash }, coverage: { id: 'test', hash, maskKey: 'mask', maxZoom: 5 }, grid: GFS_GRID, frames, layers: [...LAYER_IDS], artifacts, source: {}, tool: {}, palettes: ['lift'], metrics: {} } };
}

describe('immutable publication', () => {
  it('publishes only after artifact and manifest verification', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { now: () => now });
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe(id);
    expect(store.objects.size).toBe(50);
    expect(store.checksums).toHaveLength(48);
    const artifactGets = store.gets.filter(call => call.key.startsWith(`builds/gfs/${id}/`) && !call.key.endsWith('/manifest.json'));
    expect(artifactGets).toHaveLength(48);
    expect(artifactGets.every(call => call.range?.length === 32)).toBe(true);
    await expect(publish(store, root, manifest, { now: () => now, allowSameCycle: true })).rejects.toThrow();
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('single-PUT MD5 ETag or size mismatch');
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
      if (!key.endsWith('.bin') && !key.endsWith('.pmtiles')) return;
      active++; maximum = Math.max(maximum, active);
      if (++started === 4) ready();
      await gate;
      active--;
    };
    const result = publish(store, root, manifest, { now: () => now });
    await four;
    expect(started).toBe(4);
    release();
    await result;
    expect(maximum).toBe(4);
    expect(store.checksums).toHaveLength(48);
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
      if (!key.endsWith('.bin') && !key.endsWith('.pmtiles')) return;
      const index = ++started;
      if (started === 4) ready();
      await (index === 1 ? failGate : gate);
      settled++;
      if (index === 1) throw new Error('pool failure');
    };
    const result = publish(store, root, manifest, { now: () => now });
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('Local hash mismatch');
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('bad Content-MD5');
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('tail or ETag mismatch');
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('single-PUT MD5 ETag or size mismatch');
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('tail or ETag mismatch');
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
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('tail or ETag mismatch');
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
    await publish(store, root, manifest, { now: () => now });
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
    await expect(publish(store, root, manifest, { now: () => clock })).rejects.toThrow('lifetime');
    expect(started).toBeLessThanOrEqual(4);
    expect(store.objects.has(`builds/gfs/${id}/manifest.json`)).toBe(false);
    expect(store.objects.has('catalog/gfs/latest.json')).toBe(false);
  });
  it('leaves pointer untouched after interrupted upload and rejects expired IDs', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    store.failKey = manifest.artifacts[2].tilesKey;
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('injected');
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
    await expect(publish(store, root, manifest, { now: () => now + 7 * 3600000 })).rejects.toThrow('lifetime');
    expect(buildIdTime(id)).toBe(now - 60000);
  });
  it('does not admit a losing create-only CAS after a competing first publication', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const winner: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'winner', retained: [{ buildId: 'winner', manifestKey: 'winner', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    store.beforePut = key => { if (key === 'catalog/gfs/latest.json') store.objects.set(key, { bytes: Buffer.from(JSON.stringify(winner)), etag: 'winner-etag', lastModified: new Date(now) }); };
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('precondition failed');
    expect(await store.get(`builds/gfs/${id}/manifest.json`)).not.toBeNull();
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe('winner');
  });
  it('does not overwrite a concurrent pointer update with stale If-Match', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const entry = { buildId: 'previous', manifestKey: 'previous', cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: 'previous', retained: [entry] })), { ifNoneMatch: '*' });
    store.beforePut = key => { if (key === 'catalog/gfs/latest.json') store.objects.set(key, { bytes: Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: 'winner', retained: [{ ...entry, buildId: 'winner' }] })), etag: 'new-etag', lastModified: new Date(now) }); };
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('precondition failed');
    expect(JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString()).latestBuildId).toBe('winner');
  });
  it('requires an unexpired retained rollback and protects retained and fresh objects during cleanup', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { now: () => now });
    await expect(rollback(store, 'gfs', id, false, now)).rejects.toThrow('Pause');
    await rollback(store, 'gfs', id, true, now);
    await expect(rollback(store, 'gfs', id, true, Date.parse(manifest.expiresAt))).rejects.toThrow('not retained');
    const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc', fresh = '20261030T053000Z-12345678-1234-4234-8234-123456789abc';
    await store.put(`builds/gfs/${stale}/part`, Buffer.from('x'), { ifNoneMatch: '*' });
    await store.put(`builds/gfs/${fresh}/part`, Buffer.from('x'), { ifNoneMatch: '*' });
    store.objects.get(`builds/gfs/${stale}/part`)!.lastModified = new Date(now - 2 * 86400000);
    expect(await cleanup(store, 'gfs', true, now)).toBe(1);
    expect(await store.get(`builds/gfs/${fresh}/part`)).not.toBeNull();
    expect(await store.get(`builds/gfs/${id}/manifest.json`)).not.toBeNull();
  });
  it('rejects older and same-cycle replacement without intent', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'existing', retained: [{ buildId: 'existing', manifestKey: 'existing', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('Same-cycle');
    pointer.retained[0].cycle = '2026-10-30T06:00:00.000Z';
    store.objects.delete('catalog/gfs/latest.json');
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { now: () => now, allowSameCycle: true })).rejects.toThrow('Older cycle');
  });
  it('admits a same-cycle replacement only with explicit intent', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'existing', retained: [{ buildId: 'existing', manifestKey: 'existing', cycle: manifest.cycle, expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await publish(store, root, manifest, { now: () => now, allowSameCycle: true });
    const result = JSON.parse(Buffer.from((await store.get('catalog/gfs/latest.json'))!.bytes).toString());
    expect(result.latestBuildId).toBe(id);
    expect(result.retained).toHaveLength(2);
  });
  it('does not allow a rollback to bypass the highest retained cycle', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const pointer: ModelPointer = { version: 1, model: 'gfs', latestBuildId: 'older', retained: [{ buildId: 'older', manifestKey: 'older', cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt }, { buildId: 'newer', manifestKey: 'newer', cycle: '2026-10-30T06:00:00.000Z', expiresAt: manifest.expiresAt }] };
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify(pointer)), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('Older cycle');
  });
  it('refuses a missing local artifact and does not commit', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await rm(localPath(root, manifest.artifacts[1].samplesKey));
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow();
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
  });
  it('checks the six-hour deadline again before committing the pointer', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    let clock = now;
    store.beforePut = key => { if (key.endsWith('/manifest.json')) clock = buildIdTime(id) + 6 * 3600000 + 1; };
    await expect(publish(store, root, manifest, { now: () => clock })).rejects.toThrow('lifetime');
    expect(await store.get('catalog/gfs/latest.json')).toBeNull();
  });
  it('refuses to evict an unexpired retained build when full', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    const retained = Array.from({ length: 128 }, (_, i) => ({ buildId: `existing-${i}`, manifestKey: `existing-${i}`, cycle: '2026-10-29T18:00:00.000Z', expiresAt: manifest.expiresAt }));
    await store.put('catalog/gfs/latest.json', Buffer.from(JSON.stringify({ version: 1, model: 'gfs', latestBuildId: retained[0].buildId, retained })), { ifNoneMatch: '*' });
    await expect(publish(store, root, manifest, { now: () => now })).rejects.toThrow('limit');
    expect(store.objects.size).toBe(1);
  });
  it('protects a stale build prefix containing a recently modified object', async () => {
    const { root, manifest } = await fixture(), store = new MemoryStore();
    await publish(store, root, manifest, { now: () => now });
    const stale = '20261028T000000Z-12345678-1234-4234-8234-123456789abc';
    await store.put(`builds/gfs/${stale}/old`, Buffer.from('x'), { ifNoneMatch: '*' });
    await store.put(`builds/gfs/${stale}/new`, Buffer.from('x'), { ifNoneMatch: '*' });
    store.objects.get(`builds/gfs/${stale}/old`)!.lastModified = new Date(now - 2 * 86400000);
    store.objects.get(`builds/gfs/${stale}/new`)!.lastModified = new Date(now - 1000);
    expect(await cleanup(store, 'gfs', true, now)).toBe(0);
  });
});
