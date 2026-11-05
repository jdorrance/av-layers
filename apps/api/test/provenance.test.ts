import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readProvenanceFrame } from '../src/publication';
import { createV5Fixture, NOW } from './v5-fixture';

const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function fixture(count = 2, padding = 0) {
  const f = createV5Fixture({ framePrefix: 'f', frameHours: Array.from({ length: count }, (_, index) => index + 1) });
  const m = f.manifest, prefix = `builds/${m.model}/${m.buildId}`;
  const frames = m.frames.map((frame, index) => {
    const value = { version: 1, model: m.model, buildId: m.buildId, cycle: m.cycle, frame, hour: index + 1,
      intervals: { profileTime: frame.validTime, fluxWindow: { start: frame.intervalStart, end: frame.intervalEnd },
        precipitationWindow: { start: frame.intervalStart, end: frame.intervalEnd } }, receipt: { source: 'x'.repeat(padding) } };
    const bytes = encode(value), key = `${prefix}/provenance/${frame.id}.json`;
    f.objects.set(key, bytes);
    return { frame: frame.id, hour: index + 1, key, bytes: bytes.length, sha256: hash(bytes) };
  });
  const index = { version: 2, model: m.model, buildId: m.buildId, cycle: m.cycle, frames };
  const commit = () => {
    const bytes = encode(index); f.objects.set(m.source.provenanceKey, bytes); m.source.provenanceSha256 = hash(bytes);
    f.objects.set(`${prefix}/manifest.json`, encode(m));
  };
  commit();
  const request = (query = '') => f.request(`/v1/models/${m.model}/runs/${m.buildId}/provenance${query}`);
  return { ...f, index, commit, request };
}

it('serves a verified run index and exact selected frame receipt through the route', async () => {
  const f = fixture(), response = await f.request();
  expect(response.status).toBe(200); expect(await response.json()).toEqual(f.index);
  const frame = await f.request('?frame=f002');
  expect(frame.status).toBe(200); expect(frame.headers.get('etag')).toBe(`"${f.index.frames[1]!.sha256}"`);
  const value = await frame.json() as { frame: { id: string }; hour: number };
  expect(value.frame.id).toBe('f002'); expect(value.hour).toBe(2);
});

it('rejects unknown frames without loading provenance and preserves legacy inline provenance', async () => {
  const f = fixture(), unknown = await f.request('?frame=f003');
  expect(unknown.status).toBe(404); await unknown.arrayBuffer();
  expect(f.get.mock.calls.some(([key]) => key.includes('/provenance'))).toBe(false);
  const legacy = createV5Fixture();
  const path = `/v1/models/${legacy.manifest.model}/runs/${legacy.buildId}/provenance`;
  const response = await legacy.request(path);
  expect(response.status).toBe(200); expect((await response.json() as { version: number }).version).toBe(1);
  const unavailable = await legacy.request(`${path}?frame=h001`);
  expect(unavailable.status).toBe(409); await unavailable.arrayBuffer();
});

it('rejects missing, short, corrupt and scientifically mismatched frame files', async () => {
  for (const kind of ['missing', 'short', 'hash', 'identity'] as const) {
    const f = fixture(), reference = f.index.frames[0]!, bytes = f.objects.get(reference.key)!;
    if (kind === 'missing') f.objects.delete(reference.key);
    if (kind === 'short') f.objects.set(reference.key, bytes.subarray(0, bytes.length - 1));
    if (kind === 'hash') f.objects.set(reference.key, new Uint8Array(bytes.length));
    if (kind === 'identity') {
      const value = JSON.parse(new TextDecoder().decode(bytes)); value.intervals.fluxWindow.start = value.intervals.fluxWindow.end;
      const changed = encode(value); f.objects.set(reference.key, changed); reference.bytes = changed.length; reference.sha256 = hash(changed); f.commit();
    }
    const result = await f.request('?frame=f001');
    expect(result.status, kind).toBe(503); expect(result.headers.get('cache-control')).toBe('no-store'); await result.arrayBuffer();
  }
});

it('shares an index read and admits eight small frame files using their actual byte reservations', async () => {
  const f = fixture(8, 200_000), ctx = { waitUntil() {} };
  const receipts = await Promise.all(f.manifest.frames.map(frame => readProvenanceFrame(f.bucket, f.manifest, frame.id, ctx)));
  expect(receipts).toHaveLength(8);
  expect(f.get.mock.calls.filter(([key]) => key === f.manifest.source.provenanceKey)).toHaveLength(1);
  expect(f.get.mock.calls.filter(([key]) => key.includes('/provenance/'))).toHaveLength(8);
});

it('cancels an individual waiter without interrupting its shared index and frame survivor', async () => {
  const f = fixture(), original = f.get.getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  f.get.mockImplementation(async (key, options) => { if (key === f.manifest.source.provenanceKey) await held; return original(key, options); });
  const stopped = new AbortController(), ctx = { waitUntil() {} };
  const first = readProvenanceFrame(f.bucket, f.manifest, 'f001', ctx, stopped.signal);
  const rejected = expect(first).rejects.toThrow('cancelled');
  const second = readProvenanceFrame(f.bucket, f.manifest, 'f001', ctx);
  stopped.abort(new Error('cancelled')); await rejected; release();
  expect((await second).sha256).toBe(f.index.frames[0]!.sha256);
  expect(f.get.mock.calls.filter(([key]) => key === f.manifest.source.provenanceKey)).toHaveLength(1);
  expect(f.get.mock.calls.filter(([key]) => key.includes('/provenance/'))).toHaveLength(1);
});
