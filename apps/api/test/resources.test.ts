import { describe, expect, it, vi } from 'vitest';
import { ByteCache, MaterializedReads, readBoundedStream } from '../src/resources';

describe('serving resource bounds', () => {
  it('evicts by bytes and recency, expires entries and refuses oversized entries', () => {
    const cache = new ByteCache<string, number>(3, 10);
    cache.set('a', 1, 4); cache.set('b', 2, 4);
    expect(cache.get('a')).toBe(1);
    cache.set('c', 3, 4);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.bytes).toBe(8);
    cache.set('large', 4, 11);
    expect(cache.get('large')).toBeUndefined();
    cache.set('short', 5, 1, Date.now() + 1000);
    expect(cache.get('short', Date.now() + 1001)).toBeUndefined();
    expect(cache.bytes).toBe(8);
  });
  it('coalesces materialized reads, holds the owner context and allows retry after failure', async () => {
    const reads = new MaterializedReads<number>(1);
    let release!: (value: number) => void;
    const load = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
    const ctx = { waitUntil: vi.fn() };
    const first = reads.run('same', load, ctx), second = reads.run('same', load, ctx);
    await Promise.resolve();
    expect(first).toBe(second); expect(load).toHaveBeenCalledTimes(1); expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await expect(reads.run('different', async () => 3)).rejects.toThrow('concurrent');
    release(2); expect(await second).toBe(2);
    await expect(reads.run('bad', async () => { throw new Error('failed'); })).rejects.toThrow('failed');
    expect(await reads.run('bad', async () => 4)).toBe(4);
  });
  it('cancels a stream as soon as the byte budget is exceeded', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(6)); }, cancel
    });
    await expect(readBoundedStream(stream, 10)).rejects.toThrow('byte budget');
    expect(cancel).toHaveBeenCalledOnce();
  });
});

it('bounds JSON nesting and structural allocation while ignoring punctuation in strings', async () => {
  const { parseBoundedJson } = await import('../src/resources');
  const bytes = (value: string) => new TextEncoder().encode(value);
  expect(parseBoundedJson(bytes(JSON.stringify({ text: '[]{}:,\\"'.repeat(5000) })))).toHaveProperty('text');
  expect(() => parseBoundedJson(bytes('['.repeat(33) + '0' + ']'.repeat(33)))).toThrow('nesting');
  expect(() => parseBoundedJson(bytes('[' + Array.from({ length: 8193 }, () => '0').join(',') + ']'))).toThrow(/structure|property/);
});

it('uses bounded buffers for fragmented streams, cancels stalled reads and releases failed acquisitions', async () => {
  let sent = 0;
  const fragmented = new ReadableStream<Uint8Array>({ pull(controller) { if (sent++ < 10_000) controller.enqueue(Uint8Array.of(7)); else controller.close(); } });
  const result = await readBoundedStream(fragmented, 10_000);
  expect(result.length).toBe(10_000); expect(result.every(value => value === 7)).toBe(true);
  const cancel = vi.fn();
  await expect(readBoundedStream(new ReadableStream({ cancel }), 10, undefined, { timeoutMs: 5 })).rejects.toThrow('deadline');
  expect(cancel).toHaveBeenCalledOnce();
  const stream = new ReadableStream<Uint8Array>(), locked = stream.getReader();
  await expect(readBoundedStream(stream, 16 * 1024 * 1024)).rejects.toThrow();
  locked.releaseLock();
  const { reserveAllocation } = await import('../src/resources');
  const release = reserveAllocation(32 * 1024 * 1024); release();
});

it('cancels timed-out coalesced operations and permits a fresh retry', async () => {
  const reads = new MaterializedReads<number>(1, 5);
  let signal: AbortSignal | undefined;
  await expect(reads.run('slow', async value => { signal = value; return new Promise(() => {}); })).rejects.toThrow('deadline');
  expect(signal?.aborted).toBe(true);
  expect(await reads.run('slow', async () => 42)).toBe(42);
});

it('rejects large flat object graphs before parsing and admits bounded realistic receipt structure', async () => {
  const { parseBoundedJson } = await import('../src/resources');
  const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
  expect(() => parseBoundedJson(encode(Object.fromEntries(Array.from({ length: 30_000 }, (_, i) => [`field${i}`, i]))), 65_536)).toThrow('property');
  const receipt = { version: 1, model: 'gfs', buildId: 'build-1', cycle: '2026-11-01T00:00:00Z', frames: Array.from({ length: 8 }, () => ({ fields: Array.from({ length: 53 }, () => ({ records: Array.from({ length: 13 }, () => ({ offset: 1, length: 2, field: 'TMP', level: 850 })) })) })) };
  const bytes = encode(receipt);
  expect(() => parseBoundedJson(bytes)).toThrow('structure');
  expect(parseBoundedJson(bytes, 65_536)).toEqual(receipt);
});

it('holds outgoing body permits until consumption or cancellation', async () => {
  const { boundResponse } = await import('../src/resources');
  const responses = Array.from({ length: 4 }, () => boundResponse(new Response(new Uint8Array(1024 * 1024), { headers: { 'content-length': String(1024 * 1024) } })));
  expect(() => boundResponse(new Response('x'))).toThrow('Outgoing response');
  await responses[0].arrayBuffer();
  const recovered = boundResponse(new Response('ok', { headers: { 'content-length': '2' } }));
  expect(await recovered.text()).toBe('ok');
  await Promise.all(responses.slice(1).map(response => response.body!.cancel()));
});


it('reserves before body allocation and holds a stalled Cache API branch after its client finishes', async () => {
  const { createBoundedResponse, forkResponseForCache } = await import('../src/resources');
  const size = 1024 * 1024;
  const branches = Array.from({ length: 4 }, () => forkResponseForCache(createBoundedResponse(size, () => new Response(new Uint8Array(size), { headers: { 'content-length': String(size) } }))));
  const allocate = vi.fn(() => new Response('x'));
  expect(() => createBoundedResponse(1, allocate)).toThrow('Outgoing response');
  expect(allocate).not.toHaveBeenCalled();
  await Promise.all(branches.map(({ client }) => client.arrayBuffer()));
  expect(() => createBoundedResponse(1, allocate)).toThrow('Outgoing response');
  await Promise.all(branches.map(({ cache }) => cache.body!.cancel()));
  expect(await createBoundedResponse(1, allocate).text()).toBe('x');
});

it('reclaims a stalled cache branch at its deadline without releasing an active sibling early', async () => {
  const { createBoundedResponse, forkResponseForCache } = await import('../src/resources');
  const size = 1024 * 1024;
  const branches = Array.from({ length: 4 }, () => forkResponseForCache(createBoundedResponse(size, () => new Response(new Uint8Array(size), { headers: { 'content-length': String(size) } })), 30));
  await Promise.all(branches.map(({ client }) => client.arrayBuffer()));
  expect(() => createBoundedResponse(1, () => new Response('x'))).toThrow('Outgoing response');
  await new Promise(resolve => setTimeout(resolve, 45));
  expect(await createBoundedResponse(1, () => new Response('x')).text()).toBe('x');
  await expect(branches[0].cache.arrayBuffer()).rejects.toThrow('deadline');
});


it('caps total coalesced waiters across keys and reclaims all permits after completion', async () => {
  const reads = new MaterializedReads<number>(16, 15_000, 32);
  let release!: (value: number) => void;
  const load = vi.fn(() => new Promise<number>(resolve => { release = resolve; }));
  const admitted = Array.from({ length: 32 }, () => reads.run('same', load));
  await expect(reads.run('same', load)).rejects.toThrow('waiters');
  await expect(reads.run('another', async () => 9)).rejects.toThrow('waiters');
  expect(load).toHaveBeenCalledOnce();
  release(7); expect(await Promise.all(admitted)).toEqual(Array(32).fill(7));
  expect(await reads.run('another', async () => 9)).toBe(9);
});


it('aborts sibling reads when a coalesced loader fails and permits a clean retry', async () => {
  const reads = new MaterializedReads<Uint8Array[]>(1), cancel = vi.fn();
  let signal: AbortSignal | undefined;
  await expect(reads.run('same', value => {
    signal = value;
    return Promise.all([readBoundedStream(new ReadableStream({ cancel }), 1024, undefined, { signal: value }), Promise.reject(new Error('missing sibling'))]);
  })).rejects.toThrow('missing sibling');
  expect(signal?.aborted).toBe(true); expect(cancel).toHaveBeenCalledOnce();
  expect(await reads.run('same', async () => [Uint8Array.of(3)])).toEqual([Uint8Array.of(3)]);
});
