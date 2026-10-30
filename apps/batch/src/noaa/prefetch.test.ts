import { expect, it, vi } from 'vitest';
import { prefetchFields } from './prefetch.ts';

it('bounds reservations until consumption and yields source order despite out-of-order fetches', async () => {
  const controller = new AbortController(), peaks: number[] = [];
  const resolve: Array<(value: number) => void> = [];
  const load = vi.fn((i: number) => new Promise<number>(done => { resolve[i] = done; }));
  const stream = prefetchFields([0, 1, 2], () => 6, load, { concurrency: 3, maxBytes: 12, signal: controller.signal, fail: e => controller.abort(e), peak: b => peaks.push(b) });
  const first = stream.next();
  expect(load).toHaveBeenCalledTimes(2);
  resolve[1]!(1); resolve[0]!(0);
  expect(await first).toEqual({ done: false, value: 0 });
  expect(load).toHaveBeenCalledTimes(2);
  expect(await stream.next()).toEqual({ done: false, value: 1 });
  expect(load).toHaveBeenCalledTimes(3);
  resolve[2]!(2);
  expect(await stream.next()).toEqual({ done: false, value: 2 });
  expect(await stream.next()).toEqual({ done: true, value: undefined });
  expect(Math.max(...peaks)).toBe(12);
  expect(controller.signal.aborted).toBe(false);
});

it('cancels prefetched siblings on consumer failure without dequeuing more work', async () => {
  const controller = new AbortController();
  const load = vi.fn(async (i: number) => {
    if (i === 0) return i;
    return await new Promise<number>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }));
  });
  const stream = prefetchFields([0, 1, 2], () => 1, load, { concurrency: 2, maxBytes: 2, signal: controller.signal, fail: e => controller.abort(e), peak: () => {} });
  const failure = new Error('decode failed');
  await expect((async () => { for await (const _value of stream) { void _value; throw failure; } })()).rejects.toBe(failure);
  expect(load).toHaveBeenCalledTimes(2);
  expect(controller.signal.aborted).toBe(true);
});

it('rejects oversized reservations before starting a fetch', async () => {
  const controller = new AbortController(), load = vi.fn(async () => 0);
  const stream = prefetchFields([0], () => 3, load, { concurrency: 1, maxBytes: 2, signal: controller.signal, fail: e => controller.abort(e), peak: () => {} });
  await expect(stream.next()).rejects.toThrow('byte budget');
  expect(load).not.toHaveBeenCalled();
});
