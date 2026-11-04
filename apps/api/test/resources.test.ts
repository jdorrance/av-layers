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
    expect(load).toHaveBeenCalledTimes(1); expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    await expect(reads.run('different', async () => 3)).rejects.toThrow('concurrent');
    release(2); expect(await Promise.all([first, second])).toEqual([2, 2]);
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

it('holds admission after a deadline until an uncancellable owner actually settles', async () => {
  const reads = new MaterializedReads<number>(1, 5);
  let signal: AbortSignal | undefined;
  let finish!: (value: number) => void;
  const owners: Promise<unknown>[] = [];
  const replacement = vi.fn(async () => 42);
  await expect(reads.run('slow', async value => { signal = value; return new Promise(resolve => { finish = resolve; }); }, { waitUntil: promise => owners.push(promise) })).rejects.toThrow('deadline');
  expect(signal?.aborted).toBe(true);
  await expect(reads.run('slow', replacement)).rejects.toThrow('deadline');
  await expect(reads.run('another', replacement)).rejects.toThrow('concurrent');
  expect(replacement).not.toHaveBeenCalled();
  finish(7);
  await Promise.all(owners);
  expect(await reads.run('slow', replacement)).toBe(42);
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

it('releases outgoing body permits immediately when both forked branches complete without waiting for the deadline', async () => {
  const { createBoundedResponse, forkResponseForCache } = await import('../src/resources');
  const size = 1024 * 1024;
  const branches = Array.from({ length: 4 }, () => forkResponseForCache(createBoundedResponse(size, () => new Response(new Uint8Array(size), { headers: { 'content-length': String(size) } })), 15_000));
  await Promise.all(branches.flatMap(({ client, cache }) => [client.arrayBuffer(), cache.arrayBuffer()]));
  const recovered = Array.from({ length: 4 }, () => createBoundedResponse(size, () => new Response('ok')));
  expect(await Promise.all(recovered.map(response => response.text()))).toEqual(['ok', 'ok', 'ok', 'ok']);
});

it('keeps the original cache sibling readable when its client is forked again', async () => {
  const { createBoundedResponse, forkResponseForCache } = await import('../src/resources');
  const first = forkResponseForCache(createBoundedResponse(3, () => new Response('abc')));
  const next = forkResponseForCache(first.client);
  expect(await Promise.all([first.cache.text(), next.client.text(), next.cache.text()])).toEqual(['abc', 'abc', 'abc']);
});

it('cancels a failed cache clone and returns its outgoing permit', async () => {
  const { createBoundedResponse, forkResponseForCache } = await import('../src/resources');
  const { finish } = await import('../src/http');
  const size = 1024 * 1024, cancel = vi.fn();
  for (let i = 0; i < 4; i++) {
    const bounded = createBoundedResponse(size, () => new Response(new ReadableStream({ cancel })));
    const result = finish(new Request('https://api.example/test'), bounded);
    vi.spyOn(result, 'clone').mockImplementation(() => { throw new Error('clone failed'); });
    expect(() => forkResponseForCache(result)).toThrow('clone failed');
  }
  expect(cancel).toHaveBeenCalledTimes(4);
  expect(await createBoundedResponse(size, () => new Response('ok')).text()).toBe('ok');
});

it('cancels constructed responses and reclaims outgoing permits when expiry is discovered during finish', async () => {
  const { finish, response } = await import('../src/http');
  const size = 1024 * 1024;
  for (let i = 0; i < 4; i++) {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 1_000).toISOString();
    expect(() => finish(new Request('https://api.example/test'), response(new Uint8Array(size), 'application/octet-stream', future), past)).toThrow();
  }
  expect((await response(new Uint8Array(size), 'application/octet-stream').arrayBuffer()).byteLength).toBe(size);
});

it('cancels an already constructed body when the build expires while awaiting its producer', async () => {
  const { cached, finish, response } = await import('../src/http');
  const size = 1024 * 1024, start = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(start);
  const bodies: Response[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      clock.mockReturnValue(start);
      const expiry = new Date(start + 1000).toISOString();
      let created!: () => void, complete!: () => void;
      const started = new Promise<void>(resolve => { created = resolve; });
      const gate = new Promise<void>(resolve => { complete = resolve; });
      const pending = cached(new Request('https://api.example/test'), expiry, { waitUntil() {} }, async () => {
        const result = response(new Uint8Array(size), 'application/octet-stream', expiry);
        bodies.push(result); created();
        await gate;
        return result;
      });
      await started;
      clock.mockReturnValue(start + 1001);
      complete();
      await expect(pending).rejects.toThrow('expired');
    }
    const ok = response(new Uint8Array(size), 'application/octet-stream');
    expect((await finish(new Request('https://api.example/test'), ok).arrayBuffer()).byteLength).toBe(size);
  } finally {
    clock.mockRestore();
    await Promise.all(bodies.map(body => body.body?.cancel().catch(() => {})));
  }
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

it('cancels one waiter without aborting the shared owner or its admission', async () => {
  const reads = new MaterializedReads<number>(1, 15_000, 2), controller = new AbortController();
  let finish!: (value: number) => void, owner!: AbortSignal;
  const load = vi.fn((signal: AbortSignal) => { owner = signal; return new Promise<number>(resolve => { finish = resolve; }); });
  const first = reads.run('same', load, undefined, controller.signal), second = reads.run('same', load);
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  expect(owner.aborted).toBe(false);
  await expect(reads.run('other', async () => 1)).rejects.toThrow('concurrent');
  const replacement = reads.run('same', load);
  expect(load).toHaveBeenCalledOnce();
  finish(9);
  expect(await Promise.all([second, replacement])).toEqual([9, 9]);
  expect(await reads.run('other', async () => 1)).toBe(1);
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
