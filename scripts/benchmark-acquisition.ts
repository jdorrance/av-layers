import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createGfsAcquisitionSession } from '../apps/batch/src/noaa/acquire.js';

const usage = 'Usage: --cache-dir PATH --cycle ISO [--hours 3,6|all] [--concurrency 1|2|4] [--online] [--output FILE]\nOffline by default. Omit --concurrency for production defaults: fetch 2 / decode 1 / 128 MiB. Explicit concurrency tests use 256 MiB. --online permits cache fill; an empty cache is required to measure network-cold input.';
const { values } = parseArgs({ options: { help: { type: 'boolean' }, 'cache-dir': { type: 'string' }, cycle: { type: 'string' }, concurrency: { type: 'string' }, hours: { type: 'string', default: '3,6' }, online: { type: 'boolean', default: false }, output: { type: 'string' } } });
if (values.help) { console.log(usage); process.exit(0); }
if (!values['cache-dir'] || !values.cycle) throw new Error(usage);
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
if (concurrency !== undefined && ![1, 2, 4].includes(concurrency)) throw new RangeError('Benchmark concurrency must be 1, 2 or 4');
const hours = values.hours === 'all' ? [3, 6, 9, 12, 15, 18, 21, 24] : values.hours!.split(',').map(Number);
if (!hours.length || new Set(hours).size !== hours.length || hours.some(hour => !Number.isInteger(hour) || hour < 3 || hour > 24 || hour % 3 !== 0)) throw new Error('Expected distinct forecast hours 3..24 divisible by 3');
const [output, halo] = await Promise.all(['output', 'halo'].map(name => readFile(new URL(`../packages/contracts/coverage/${name}.bin`, import.meta.url))));
const active: number[] = [];
for (let i = 0; i < 1440 * 721; i++) if ((output[i >> 3] | halo[i >> 3]) & (1 << (i & 7))) active.push(i);
const hash = createHash('sha256');
function fingerprint(value: unknown, path = ''): void {
  if (ArrayBuffer.isView(value)) { hash.update(path); hash.update(Buffer.from(value.buffer, value.byteOffset, value.byteLength)); }
  else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (key !== 'capturedAt') fingerprint(child, `${path}/${key}`); }
  else hash.update(`${path}:${JSON.stringify(value)}\n`);
}
const started = performance.now(), cpu = process.cpuUsage();
const session = await createGfsAcquisitionSession({
  cycle: values.cycle, activeIndices: Uint32Array.from(active), cacheDir: resolve(values['cache-dir']),
  ...(concurrency === undefined ? {} : { fetchConcurrency: concurrency, decodeConcurrency: concurrency, prefetchBytes: 256 * 1024 * 1024 }),
  ...(values.online ? {} : { retry: { maxAttempts: 1 }, fetch: async (input: RequestInfo | URL) => { throw new Error(`Offline benchmark cache miss: ${String(input)}`); } })
});
try {
  for (const hour of hours) fingerprint(await session.acquire(hour), `f${hour}`);
} finally { await session.close(); }
const receipt = {
  kind: values.online ? 'gfs-acquisition-cache-fill' : 'cached-gfs-acquisition-concurrency', node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model,
  cycle: values.cycle, hours, activeCells: active.length, concurrency: concurrency ?? 'production-default', networkAllowed: values.online, elapsedMs: performance.now() - started,
  cpuMicros: process.cpuUsage(cpu), peakRssBytes: process.resourceUsage().maxRSS * 1024,
  outputSha256: hash.digest('hex'), stats: session.stats
};
if (values.output) { await mkdir(dirname(resolve(values.output)), { recursive: true }); await writeFile(values.output, JSON.stringify(receipt, null, 2)); }
console.log(JSON.stringify(receipt));
