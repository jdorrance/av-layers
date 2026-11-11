import { expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const requireApi = createRequire(new URL('../package.json', import.meta.url));
const { createTestHarness } = requireApi('wrangler') as typeof import('wrangler');

async function deadline<T>(operation: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const exceeded = new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  try { return await Promise.race([operation, exceeded]); }
  finally { clearTimeout(timeout); }
}

it('shares real R2 reads across disconnects and bounds cache responses', async () => {
  const server = createTestHarness({ workers: [{ config: {
    name: 'av-serving-runtime-test', main: fileURLToPath(new URL('./runtime-worker.ts', import.meta.url)),
    compatibility_date: '2026-10-01', compatibility_flags: ['enable_request_signal'],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: 'local-runtime-test' }]
  } }] });
  const active: Promise<unknown>[] = [];
  let releaseWorker: (() => Promise<string>) | undefined;
  try {
    const { url: base } = await deadline(server.listen(), 8000, 'Worker boot');
    const fetchWorker = (path: string, signal?: AbortSignal) => fetch(new URL(path, base), { signal: signal ? AbortSignal.any([AbortSignal.timeout(4000), signal]) : AbortSignal.timeout(4000) });
    releaseWorker = () => fetchWorker('/release').then(response => response.text());
    const stats = async () => (await fetchWorker('/stats')).json();
    const until = (expected: Record<string, number | boolean>) => vi.waitFor(async () => {
      expect(await stats()).toMatchObject(expected);
    }, { timeout: 2500, interval: 10 });
    const canceled = (path: string, controller: AbortController) => {
      const result = fetchWorker(path, controller.signal).then(() => { throw new Error(`${path} completed before cancellation`); }, error => error);
      active.push(result);
      return result;
    };

    expect(await (await fetchWorker('/seed')).text()).toBe('ok');
    const owner = new AbortController(), queued = new AbortController();
    const ownerResult = canceled('/owner', owner);
    await until({ loads: 1, waiters: 1 });
    const queuedResult = canceled('/queued', queued);
    const joined = Array.from({ length: 8 }, () => fetchWorker('/read').then(response => response.json()));
    active.push(...joined);
    await until({ loads: 1, waiters: 10, queuedLoads: 0 });
    owner.abort(); queued.abort();
    expect((await ownerResult).name).toBe('AbortError');
    expect((await queuedResult).name).toBe('AbortError');
    // The local proxy may defer transport abort delivery. Cancel both waiters
    // inside workerd before releasing the R2 owner.
    await (await fetchWorker('/cancel')).text();
    await until({ aborted: 2 });
    await releaseWorker();
    for (const result of await Promise.all(joined)) expect(result).toEqual({ bytes: [7, 8, 9], loads: 1 });
    expect(await stats()).toMatchObject({ loads: 1, queuedLoads: 0 });

    await (await fetchWorker('/cached')).arrayBuffer();
    await until({ cacheReady: true });
    const hits = await Promise.all(Array.from({ length: 20 }, () => fetch(new URL('/cached', base), {
      headers: { 'x-av-cached-bytes': '0' }, signal: AbortSignal.timeout(4000)
    })));
    for (const hit of hits) {
      expect(hit.status).toBe(200);
      expect(hit.headers.has('x-av-cached-bytes')).toBe(false);
      expect((await hit.arrayBuffer()).byteLength).toBe(20 * 1024);
    }
    const discovery = await fetchWorker('/discovery');
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toEqual({ loads: 1 });
    const remaining = Number(/s-maxage=(\d+)/.exec(discovery.headers.get('cache-control') ?? '')?.[1]);
    expect(remaining).toBeGreaterThan(0); expect(remaining).toBeLessThanOrEqual(15);
    await until({ discoveryReady: true });
    const shared = await fetchWorker('/discovery');
    expect(shared.status).toBe(200);
    expect(await shared.json()).toEqual({ loads: 1 });
    expect(shared.headers.get('cache-control')).toMatch(/^public, max-age=0, s-maxage=\d+, must-revalidate$/);
  } finally {
    await releaseWorker?.().catch(() => {});
    await Promise.allSettled(active);
    await deadline(server.close(), 4000, 'Worker shutdown');
  }
}, 25_000);
