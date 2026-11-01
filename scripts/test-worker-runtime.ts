import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Use the explicitly installed API Wrangler, with disposable local-only storage.
const requireApi = createRequire(resolve('apps/api/package.json'));
const { unstable_dev } = requireApi('wrangler') as typeof import('../apps/api/node_modules/wrangler');
const temporary = await mkdtemp(resolve(tmpdir(), 'av-workerd-'));
const config = resolve(temporary, 'wrangler.json');
await writeFile(config, JSON.stringify({ name: 'av-serving-runtime-test', compatibility_date: '2026-10-01', r2_buckets: [{ binding: 'BUCKET', bucket_name: 'local-runtime-test' }] }));
let worker: Awaited<ReturnType<typeof unstable_dev>> | undefined;
try {
  worker = await unstable_dev(resolve('apps/api/test/runtime-worker.ts'), { config, local: true, ip: '127.0.0.1', port: 0, inspectorPort: 0, persist: false, logLevel: 'error', experimental: { disableExperimentalWarning: true, disableDevRegistry: true, watch: false, enableContainers: false } });
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
  assert.equal((await canceled).name, 'AbortError');
  for (const result of await Promise.all(joined)) assert.deepEqual(result, { bytes: [7, 8, 9], loads: 1 });
  assert.deepEqual(await (await fetch(`${base}/stats`)).json(), { loads: 1 });
  console.log(JSON.stringify({ test: 'workerd-materialized-read-coalescing', canceledOwner: true, joiningRequests: 8, r2Reads: 1, passed: true }));
} finally { await worker?.stop(); await rm(temporary, { recursive: true, force: true }); }
