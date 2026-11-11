import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import type { ForecastSourceStore } from '../provider.js';
import { indexedGribCurrentSpecs, indexedGribFileUrl } from './fields.ts';
import { createIndexedGribProvider } from './provider.ts';
import { readIndexedR2Run, upstreamReadySchema } from './ready.ts';
import { indexedSource } from './source.ts';
import { IndexedGribTransport, sha256 } from './transport.ts';

const cycle = '2026-11-05T00:00:00Z', stamp = '2026110500';
const model = { ...INDEXED_PRODUCT, modelId: 'private-fixture', frameHours: [1, 2],
  forecast: { ...INDEXED_PRODUCT.forecast, hours: [1, 2], statisticsResetHours: 1 },
  upstream: { ...INDEXED_PRODUCT.upstream, urlTemplate: 'r2://upstream/private-fixture/{date}/{cycleHour}/{product}.f{hour}.grib2' } };
const prefix = 'upstream/private-fixture/20261105/00/';

function fixture() {
  const source = indexedSource(model), provider = createIndexedGribProvider(model);
  const objects = new Map<string, { bytes: Buffer; etag: string; hash: string }>();
  const set = (key: string, bytes: Buffer) => {
    const object = { bytes, etag: `"${createHash('md5').update(bytes).digest('hex')}"`, hash: sha256(bytes) };
    objects.set(key, object);
    return object;
  };
  const files = [1, 2].flatMap(hour => Object.entries(source.upstream.products).map(([product, name]) => {
    const key = indexedGribFileUrl(source, cycle, hour, name).slice('r2://'.length), idxKey = `${key}.idx`;
    const specs = indexedGribCurrentSpecs(source, hour).filter(spec => spec.product === product);
    const bytes = Buffer.concat(specs.map((_, index) => Buffer.alloc(16, index + 1)));
    const inventory = Buffer.from(specs.map((spec, index) => `${index + 1}:${index * 16}:d=${stamp}:${spec.variable}:${spec.level}:${spec.forecast}:`).join('\n'));
    const data = set(key, bytes), index = set(idxKey, inventory);
    return { key, bytes: bytes.byteLength, sha256: data.hash, etag: data.etag, idxKey, idxBytes: inventory.byteLength, idxSha256: index.hash, idxEtag: index.etag };
  }));
  const receipt = upstreamReadySchema.parse({ version: 1, model: model.modelId, cycle, createdAt: cycle, hours: [1, 2], files });
  const readyKey = `${prefix}_ready.json`, ready = set(readyKey, Buffer.from(JSON.stringify(receipt)));
  const latestKey = `upstream/${model.modelId}/latest.json`;
  set(latestKey, Buffer.from(JSON.stringify({ version: 1, model: model.modelId, cycle, readyKey, readySha256: ready.hash })));
  const get = vi.fn<ForecastSourceStore['get']>(async (key, range, maxBytes, signal, _onRetry, identity) => {
    signal?.throwIfAborted();
    const object = objects.get(key);
    if (!object) return null;
    if (identity && (identity.etag !== object.etag || identity.bytes !== object.bytes.byteLength)) throw new Error('Precondition failed');
    const bytes = range ? object.bytes.subarray(range.offset, range.offset + range.length) : object.bytes;
    if (maxBytes !== undefined && bytes.byteLength > maxBytes) throw new Error('Read byte budget exceeded');
    return { bytes, etag: object.etag };
  });
  const head = vi.fn<ForecastSourceStore['head']>(async key => {
    const object = objects.get(key);
    return object ? { size: object.bytes.byteLength, etag: object.etag, metadata: { sha256: object.hash } } : null;
  });
  return { source, provider, store: { get, head }, objects, set, receipt, files, latestKey, readyKey };
}

it('admits a complete private cycle from latest, pins it, and reads only bounded index bytes during discovery', async () => {
  const fixtureRun = fixture();
  const { provider, store, files, readyKey, latestKey, objects } = fixtureRun;
  const cacheDir = await mkdtemp(join(tmpdir(), 'av-private-discovery-'));
  try {
    const resolved = await provider.resolveRun!({ store, cacheDir });
    expect(resolved).toEqual({ cycle, sourcePin: { key: readyKey, bytes: objects.get(readyKey)!.bytes.length, sha256: objects.get(readyKey)!.hash } });
    expect(store.head).toHaveBeenCalledTimes(files.length * 2);
    expect(store.get.mock.calls.map(([key]) => key)).toEqual([latestKey, readyKey, ...files.slice(2).map(file => file.idxKey), ...files.slice(0, 2).map(file => file.idxKey)]);
    store.get.mockClear();
    await expect(provider.resolveRun!({ cycle, store, cacheDir })).resolves.toEqual(resolved);
    expect(store.get.mock.calls.map(([key]) => key)).toEqual([readyKey]);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

it('requires producer SHA-256 metadata before reading index or GRIB bytes', async () => {
  const { provider, store, files, readyKey } = fixture(), file = files[0]!;
  store.head.mockResolvedValueOnce({ size: file.bytes, etag: file.etag, metadata: { sha256: '0'.repeat(64) } });
  await expect(provider.resolveRun!({ cycle, store, cacheDir: '' })).rejects.toThrow('object identity differs from its receipt');
  expect(store.get.mock.calls.map(([key]) => key)).toEqual([readyKey]);
});

it('uses the pinned final record size and ETag on ranges and reuses matching disk cache entries', async () => {
  const { source, store, files, set } = fixture();
  const r2 = await readIndexedR2Run(source, { cycle, store }), file = files[0]!;
  const dir = await mkdtemp(join(tmpdir(), 'av-private-cache-'));
  const fetchImpl = vi.fn<typeof fetch>();
  try {
    const first = new IndexedGribTransport({ r2, cacheDir: dir, fetchImpl });
    const index = await first.index(`r2://${file.idxKey}`, stamp);
    const last = index.records.at(-1)!;
    expect(last).toMatchObject({ offset: file.bytes - 16, length: 16 });
    const payload = await first.field(`r2://${file.key}`, last);
    expect(payload.bytes).toHaveLength(16);
    expect(payload.asset.object).toEqual({ etag: file.etag, bytes: file.bytes, sha256: file.sha256 });
    expect(store.get).toHaveBeenLastCalledWith(file.key, { offset: file.bytes - 16, length: 16 }, 16, expect.any(AbortSignal), expect.any(Function), expect.objectContaining({ etag: file.etag, bytes: file.bytes }));
    store.get.mockClear();
    const repeat = new IndexedGribTransport({ r2, cacheDir: dir, fetchImpl });
    expect(await repeat.field(`r2://${file.key}`, last)).toEqual(payload);
    expect(repeat.stats.cacheReads).toBe(1);
    expect(store.get).not.toHaveBeenCalled();
    set(file.key, Buffer.alloc(file.bytes, 99));
    await expect(new IndexedGribTransport({ r2, fetchImpl }).field(`r2://${file.key}`, last)).rejects.toThrow('Precondition failed');
    await expect(first.field('r2://upstream/other/20261105/00/foreign.grib2', last)).rejects.toThrow('outside its admitted receipt');
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('rejects stale pointers, replaced receipts, cross-model keys and incomplete receipts before reading source data', async () => {
  const { source, store, receipt, files, set, objects, latestKey, readyKey } = fixture();
  const { pin } = await readIndexedR2Run(source, { cycle, store });
  set(readyKey, Buffer.from(JSON.stringify({ ...receipt, createdAt: '2026-11-05T01:00:00Z' })));
  await expect(readIndexedR2Run(source, { cycle, sourcePin: pin, store })).rejects.toThrow('changed after admission');
  await expect(readIndexedR2Run(source, { store })).rejects.toThrow('changed after admission');
  set(readyKey, Buffer.from(JSON.stringify({ ...receipt, files: files.slice(0, -1) })));
  await expect(readIndexedR2Run(source, { cycle, store })).rejects.toThrow('incomplete');
  const foreign = files[0]!.key.replace('/private-fixture/', '/other/');
  set(readyKey, Buffer.from(JSON.stringify({ ...receipt, files: [{ ...files[0], key: foreign, idxKey: `${foreign}.idx` }, ...files.slice(1)] })));
  await expect(readIndexedR2Run(source, { cycle, store })).rejects.toThrow('unexpected or duplicate object');
  objects.delete(readyKey);
  await expect(readIndexedR2Run(source, { cycle, store })).rejects.toMatchObject({ details: { reason: 'upstream-not-ready' } });
  objects.delete(latestKey);
  await expect(readIndexedR2Run(source, { store })).rejects.toMatchObject({ details: { reason: 'upstream-not-ready' } });
  expect(store.get.mock.calls.every(([key]) => key === readyKey || key === latestKey)).toBe(true);
});

it('checks actual IDX bytes and rejects indexed offsets past the committed GRIB length', async () => {
  const { source, store, files, receipt, objects, set, readyKey } = fixture();
  const file = files[0]!, original = objects.get(file.idxKey)!;
  const r2 = await readIndexedR2Run(source, { cycle, store });
  const invalid = Buffer.from(original.bytes);
  invalid[invalid.length - 1] = 59;
  objects.set(file.idxKey, { ...original, bytes: invalid });
  await expect(new IndexedGribTransport({ r2 }).index(`r2://${file.idxKey}`, stamp)).rejects.toThrow('index SHA-256 mismatch');
  const index = set(file.idxKey, Buffer.from(`1:0:d=${stamp}:TMP:850 mb:1 hour fcst:\n2:${file.bytes}:d=${stamp}:HGT:850 mb:1 hour fcst:`));
  set(readyKey, Buffer.from(JSON.stringify({ ...receipt, files: [{ ...file, idxBytes: index.bytes.length, idxEtag: index.etag, idxSha256: index.hash }, ...files.slice(1)] })));
  const altered = await readIndexedR2Run(source, { cycle, store });
  await expect(new IndexedGribTransport({ r2: altered }).index(`r2://${file.idxKey}`, stamp)).rejects.toThrow('record exceeds object bounds');
});

it('rejects templates that leave the model prefix or hide noncanonical paths', () => {
  for (const urlTemplate of ['r2://upstream/other/{date}/{cycleHour}/{product}.f{hour}.grib2',
    'r2://upstream/private-fixture/{date}/{cycleHour}/../{product}.f{hour}.grib2',
    'r2://upstream/private-fixture/{date}/{cycleHour}/%2e%2e/{product}.f{hour}.grib2',
    'r2://upstream/private-fixture/{date}/{cycleHour}/{product}.grib2']) {
    expect(() => indexedSource({ ...model, upstream: { ...model.upstream, urlTemplate } })).toThrow('must identify its model');
  }
});
