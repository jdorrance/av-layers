import { expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use the explicitly installed API Wrangler, with disposable local-only storage.
const requireApi = createRequire(new URL('../package.json', import.meta.url));
const { unstable_dev } = requireApi('wrangler') as typeof import('wrangler');
it('coalesces real R2 reads across requests when the initiating client disconnects', async () => {
  const temporary = await mkdtemp(resolve(tmpdir(), 'av-workerd-'));
  const config = resolve(temporary, 'wrangler.json');
  await writeFile(config, JSON.stringify({ name: 'av-serving-runtime-test', compatibility_date: '2026-10-01', r2_buckets: [{ binding: 'BUCKET', bucket_name: 'local-runtime-test' }] }));
  let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
  try {
    worker = await unstable_dev(fileURLToPath(new URL('./runtime-worker.ts', import.meta.url)), { config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false } });
    const base = `http://${worker.address}:${worker.port}`;
    await fetch(`${base}/seed`);
    const owner = new AbortController();
    const canceled = fetch(`${base}/read`, { signal: owner.signal }).then(() => { throw new Error('Owner unexpectedly completed before cancellation'); }, error => error);
    for (let attempt = 0; attempt < 20; attempt++) {
      if ((await (await fetch(`${base}/stats`)).json() as { loads: number }).loads === 1) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const joined = Array.from({ length: 8 }, () => fetch(`${base}/read`).then(response => response.json()));
    await new Promise(resolve => setTimeout(resolve, 30)); owner.abort();
    expect((await canceled).name).toBe('AbortError');
    for (const result of await Promise.all(joined)) expect(result).toEqual({ bytes: [7, 8, 9], loads: 1 });
    expect(await (await fetch(`${base}/stats`)).json()).toEqual({ loads: 1 });
    await (await fetch(`${base}/cached`)).arrayBuffer();
    await new Promise(resolve => setTimeout(resolve, 100));
    const hits = await Promise.all(Array.from({ length: 20 }, () => fetch(`${base}/cached`, { headers: { 'x-av-cached-bytes': '0' } })));
    for (const hit of hits) {
      expect(hit.status).toBe(200);
      expect(hit.headers.has('x-av-cached-bytes')).toBe(false);
      expect((await hit.arrayBuffer()).byteLength).toBe(20 * 1024);
    }
  } finally { await worker?.stop(); await rm(temporary, { recursive: true, force: true }); }
});
