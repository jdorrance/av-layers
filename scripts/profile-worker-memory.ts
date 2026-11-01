import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const requireWrangler = createRequire(resolve('apps/api/node_modules/wrangler/package.json'));
const InspectorSocket = requireWrangler('ws') as new (url: string, options: { origin: string; handshakeTimeout: number }) => WebSocket;
const argument = (name: string, fallback: string) => { const i = process.argv.indexOf(`--${name}`); return i < 0 ? fallback : process.argv[i + 1]; };
const inspector = argument('inspector', 'http://127.0.0.1:9229');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(inspector).hostname)) throw new Error('Memory profiling is local-only');
const duration = Number(argument('duration-seconds', '30'));
if (!Number.isFinite(duration) || duration < 1 || duration > 360) throw new Error('duration-seconds must be 1..360');
const targets = await (await fetch(`${inspector}/json/list`)).json() as { webSocketDebuggerUrl: string }[];
if (targets.length !== 1) throw new Error('Expected exactly one local Worker inspector target');
const socket = new InspectorSocket(targets[0].webSocketDebuggerUrl, { origin: inspector, handshakeTimeout: 10_000 });
await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => resolve(), { once: true }); socket.addEventListener('error', () => reject(new Error('Local inspector WebSocket connection failed')), { once: true }); });
const pending = new Map<number, (value: Record<string, number>) => void>();
socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)); if (pending.has(message.id)) { if (message.error) throw new Error(JSON.stringify(message.error)); pending.get(message.id)!(message.result); pending.delete(message.id); } });
const samples: Record<string, number>[] = [];
try {
  const start = performance.now();
  for (let id = 1; performance.now() - start < duration * 1000; id++) {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const usage = await Promise.race([new Promise<Record<string, number>>(resolve => { pending.set(id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.getHeapUsage' })); }), new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error('Inspector timeout')), 5000); })]).finally(() => clearTimeout(deadline));
    samples.push({ elapsedMs: Math.round(performance.now() - start), ...usage });
    await new Promise(resolve => setTimeout(resolve, 100));
  }
} finally { socket.close(); }
const bytes = (sample: Record<string, number>) => (sample.totalSize ?? sample.usedSize ?? 0) + (sample.backingStorageSize ?? 0) + (sample.embedderHeapUsedSize ?? 0);
const result = { capturedAt: new Date().toISOString(), measurement: 'Local workerd inspector surrogate: allocated JS heap + backing storage + embedder heap where exposed. No forced GC. This is sampled, not a proof of peak deployed-isolate memory.', limitBytes: 96 * 1024 * 1024, peakObservedBytes: Math.max(...samples.map(bytes)), samples };
const output = JSON.stringify(result, null, 2);
const path = argument('output', ''); if (path) await writeFile(path, output); else console.log(output);
if (result.peakObservedBytes >= result.limitBytes) process.exitCode = 1;
