import { createSecureServer, type ServerHttp2Session } from 'node:http2';
import { createServer as createHttpsServer } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { chromium, type Page } from 'playwright';
import { fixtureLatest } from '../tests/forecast-fixture.ts';
import { fixturePointFetch, fixtureProfileBuild } from '../tests/client-point-fixture.ts';
import { encodeWebp } from '../apps/batch/src/webp.ts';
import type { PreviewBench } from '../apps/preview/bench.ts';
import { DETAIL_ZOOM, TILE_SIZE, fixturePixel } from './preview-pixels';

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const baseline = option('--baseline', 'main'), repeats = Number(option('--repeats', '30')), tileDelayMs = Number(option('--delay-ms', '40'));
const output = resolve(option('--out', 'output/preview-layer-bench.json')), channel = option('--channel', ''), scenario = option('--scenario', 'all');
const variant = option('--variant', 'both'), frameCount = Number(option('--frames', '40'));
const opacity = Number(option('--opacity', '1')), transparent = args.includes('--transparent');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 200 || !Number.isInteger(tileDelayMs) || tileDelayMs < 0 || tileDelayMs > 1000 ||
  !Number.isInteger(frameCount) || frameCount < 2 || frameCount > 40 || !['all', 'cold', 'smoke'].includes(scenario) || !['both', 'baseline', 'changed'].includes(variant) || ![0.7, 1].includes(opacity)) throw new Error('Invalid benchmark options');
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'av-preview-bench-')), baselineRoot = join(scratch, 'baseline');
const certificate = join(scratch, 'localhost.pem'), privateKey = join(scratch, 'localhost-key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '1', '-nodes', '-keyout', privateKey, '-out', certificate, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
const tls = { key: await readFile(privateKey), cert: await readFile(certificate) };
const sourceDirectories = ['packages/client/src', 'apps/preview/src'];
await mkdir(baselineRoot);
const baselineRevision = execFileSync('git', ['rev-parse', baseline], { cwd: root, encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', baselineRevision, ...sourceDirectories, 'apps/preview/index.html'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
await symlink(join(root, 'node_modules'), join(baselineRoot, 'node_modules'));
await symlink(join(root, 'apps/preview/node_modules'), join(baselineRoot, 'apps/preview/node_modules'));
const maplibreDirectory = dirname(createRequire(join(root, 'apps/preview/package.json')).resolve('maplibre-gl/package.json'));
const build = fixtureProfileBuild({ frameHours: Array.from({ length: frameCount }, (_, index) => index + 1), mapFrameCount: frameCount });
build.manifest.expiresAt = new Date(Date.now() + 86400000).toISOString();
build.expiresAtMs = Date.parse(build.manifest.expiresAt);
const images = new Map<string, Promise<Buffer>>();
const geometry = new Map<string, Uint8Array>();
await encodeWebp(new Uint8Array(TILE_SIZE * TILE_SIZE * 4));
function tileImage(layer: string, frame: string, z: number, x: number, y: number): Promise<Buffer> {
  const key = `${layer}/${frame}/${z}/${x}/${y}`, hit = images.get(key);
  if (hit) return hit;
  const index = build.manifest.frames.findIndex(value => value.id === frame), geometryKey = `${z}/${x}/${y}/${transparent ? index % 3 : 0}`;
  let template = geometry.get(geometryKey);
  if (!template) {
    template = new Uint8Array(TILE_SIZE * TILE_SIZE * 4);
    const size = TILE_SIZE * 2 ** z;
    for (let row = 0; row < TILE_SIZE; row++) for (let column = 0; column < TILE_SIZE; column++) {
      template.set(fixturePixel('agl', index, z, (x * TILE_SIZE + column + 0.5) / size, (y * TILE_SIZE + row + 0.5) / size, transparent), (row * TILE_SIZE + column) * 4);
    }
    geometry.set(geometryKey, template);
  }
  // Reuse spatial geometry so synthetic trigonometry cannot dominate rapid frame changes.
  const rgba = template.slice(), [red, green] = fixturePixel(layer.endsWith('-agl') ? 'agl' : 'msl', index, z, 0, 0, false);
  for (let offset = 0; offset < rgba.length; offset += 4) { rgba[offset] = red; rgba[offset + 1] = green; }
  const image = encodeWebp(rgba); images.set(key, image); return image;
}
type Sample = Awaited<ReturnType<PreviewBench['select']>>;
function summarize(samples: Sample[]) {
  const times = (field: 'firstCorrectMs' | 'detailedMs') => {
    const sorted = samples.flatMap(sample => sample[field] === null ? [] : [sample[field]!]).sort((a, b) => a - b);
    return { count: sorted.length, p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null, maxMs: sorted.at(-1) ?? null };
  };
  return { inputs: samples.length, firstCorrectViewport: times('firstCorrectMs'), detailedViewport: times('detailedMs'), maxSources: Math.max(0, ...samples.map(sample => sample.sources)) };
}
async function sourceHash(directory: string) {
  const hash = createHash('sha256');
  for (const sourceDirectory of sourceDirectories) for (const path of (await readdir(join(directory, sourceDirectory), { recursive: true })).sort()) {
    if (!/\.(?:ts|css)$/.test(path) || path.endsWith('.test.ts')) continue;
    hash.update(`${sourceDirectory}/${path}`).update(await readFile(join(directory, sourceDirectory, path)));
  }
  hash.update(await readFile(join(directory, 'apps/preview/index.html')));
  return hash.digest('hex');
}
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const results = [];
try {
  for (const [name, codeRoot] of [['baseline', baselineRoot], ['changed', root]]) {
    if (variant !== 'both' && variant !== name) continue;
    const sourceSha256 = await sourceHash(codeRoot);
    let requests = 0, active = 0, peakActive = 0, bytes = 0, lastRequest = 0, base = '', overviewRequests = 0, overviewBytes = 0, maxImageReadyMs = 0;
    const urls = new Set<string>(), errors: string[] = [];
    const protocols = new Set<string>(), sessions = new Set<ServerHttp2Session>();
    const count = () => ({ requests, bytes, overviewRequests, overviewBytes });
    const since = (start: ReturnType<typeof count>) => ({ requests: requests - start.requests, bytes: bytes - start.bytes, overviewRequests: overviewRequests - start.overviewRequests, overviewBytes: overviewBytes - start.overviewBytes });
    const requestTimings: { frame: string; z: number; startedAt: number; finishedAt?: number }[] = [];
    const server = createSecureServer({ ...tls, allowHTTP1: true }, async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
      try {
        if (url.pathname === '/') {
          response.setHeader('content-type', 'text/html');
          response.end(await vite!.transformIndexHtml(request.url!, await readFile(join(codeRoot, 'apps/preview/index.html'), 'utf8'))); return;
        }
        if (url.pathname === '/bench/config.json') { json({ frames: build.manifest.frames.map(frame => frame.id), transparent }); return; }
        if (url.pathname === '/v1/models/gfs/latest') { json(fixtureLatest(build.manifest, base)); return; }
        if (url.pathname.endsWith('/sample') || url.pathname.endsWith('/profile')) { json(fixturePointFetch(build, `${base}${request.url}`)); return; }
        if (url.pathname.startsWith('/tiles/')) {
          protocols.add(request.httpVersion); requests++; active++; peakActive = Math.max(peakActive, active); lastRequest = Date.now(); urls.add(url.pathname);
          const [, , , , layer, frame, zoom, column, filename] = url.pathname.split('/'), z = Number(zoom), x = Number(column), y = Number(filename.replace('.webp', ''));
          if (z < DETAIL_ZOOM) overviewRequests++;
          const timing = { frame, z, startedAt: Date.now() } as { frame: string; z: number; startedAt: number; finishedAt?: number };
          requestTimings.push(timing);
          const cancellation = new AbortController();
          response.once('close', () => cancellation.abort());
          try {
            const ready = Date.now(), latency = delay(tileDelayMs, undefined, { signal: cancellation.signal });
            const imageReady = Promise.resolve().then(() => tileImage(layer, frame, z, x, y)).then(image => { maxImageReadyMs = Math.max(maxImageReadyMs, Date.now() - ready); return image; });
            const [image] = await Promise.all([imageReady, latency]);
            response.writeHead(200, { 'content-type': 'image/webp', 'content-length': image.length, 'cache-control': 'public, max-age=3600, immutable' });
            bytes += image.length; if (z < DETAIL_ZOOM) overviewBytes += image.length; timing.finishedAt = Date.now(); response.end(image);
          } catch (error) { if (!cancellation.signal.aborted) throw error; }
          finally { active--; lastRequest = Date.now(); }
          return;
        }
        // Connect consumes the compatibility fields exposed by Node's HTTP/2 request adapter.
        vite!.middlewares(request as unknown as IncomingMessage, response as unknown as ServerResponse);
      } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
    });
    server.on('session', session => { sessions.add(session); session.on('close', () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    base = `https://127.0.0.1:${address.port}`;
    // Vite's development WebSocket uses a separate HTTP/1 TLS listener; tile requests negotiate HTTP/2.
    const hmr = createHttpsServer(tls);
    await new Promise<void>(resolve => hmr.listen(0, '127.0.0.1', resolve));
    const hmrAddress = hmr.address();
    if (!hmrAddress || typeof hmrAddress === 'string') throw new Error('Missing HMR listener');
    const benchEntry = join(root, 'apps/preview/bench.ts');
    const vite = await createVite({ configFile: false, root: join(codeRoot, 'apps/preview'), cacheDir: join(scratch, name, 'vite'), logLevel: 'error',
      server: { hmr: { server: hmr, protocol: 'wss', host: '127.0.0.1', clientPort: hmrAddress.port }, middlewareMode: true, fs: { allow: [root, scratch] } }, optimizeDeps: { noDiscovery: true },
      define: { 'import.meta.env.AV_API_BASE': JSON.stringify(base), 'import.meta.env.VITE_OFFLINE_FIXTURE': '"true"' },
      resolve: { alias: [{ find: '@av/client/dom', replacement: join(codeRoot, 'packages/client/src/dom.ts') },
        { find: /^@av\/client$/, replacement: join(codeRoot, 'packages/client/src/index.ts') },
        { find: /^maplibre-gl\//, replacement: `${maplibreDirectory}/` }] },
      plugins: [{ name: 'measure-real-preview', enforce: 'pre', resolveId(id, importer) {
        if (id === 'maplibre-gl' && importer !== benchEntry) return benchEntry;
      } }]
    });
    async function openPage() {
      const start = count(), startedAt = Date.now();
      const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/?model=gfs&ref=agl&opacity=${opacity}&lat=40&lon=-100&z=7.15&t=${encodeURIComponent(build.manifest.frames[0].validTime)}`);
      await page.waitForFunction(() => !!window.bench);
      await page.evaluate(() => Promise.race([window.bench.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Initial preview did not render')), 30000))]));
      return { context, page, initial: { elapsedMs: Date.now() - startedAt, ...since(start), state: await page.evaluate(() => window.bench.snapshot()) } };
    }
    async function quiet(page: Page, maxWaitMs = 60000, required = true): Promise<boolean> {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const deadline = Date.now() + maxWaitMs;
      while (active || Date.now() - lastRequest < 180 || !await page.evaluate(() => window.bench.settled())) {
        if (Date.now() > deadline) { if (required) throw new Error('Tile transport or map did not settle'); return false; }
        await delay(25);
      }
      return true;
    }
    const samples: Record<string, Sample[]> = {}, summary: Record<string, unknown> = {}, memoryPlateau = [];
    let environment, finalEnvironment, initialHeap, finalHeap;
    try {
      for (const prepared of scenario === 'smoke' ? [false] : [false, true]) for (const intervalMs of scenario === 'smoke' ? [120] : [120, 60]) {
        const { context, page, initial } = await openPage();
        try {
          environment ??= await page.evaluate(() => window.bench.snapshot());
          const prepStart = count(), prepareAt = Date.now(), preparationSettled = prepared ? await quiet(page, 10000, false) : false;
          const preparation = { elapsedMs: Date.now() - prepareAt, settled: preparationSettled, ...since(prepStart), state: await page.evaluate(() => window.bench.snapshot()) };
          const before = count(), timingStart = requestTimings.length;
          const result = await page.evaluate(({ interval, length }) => window.bench.drag(Array.from({ length }, (_, index) => index + 1), interval), { interval: intervalMs, length: frameCount - 1 });
          const key = `${prepared ? 'afterIdle' : 'cold'}Day${intervalMs}ms`;
          samples[key] = result.samples;
          const finalInput = result.samples.at(-1)!, targetFrame = build.manifest.frames[finalInput.index].id;
          const targetHttp = requestTimings.slice(timingStart).filter(timing => timing.frame === targetFrame).map(timing => ({ z: timing.z, startMs: timing.startedAt - finalInput.inputEpochMs,
            endMs: timing.finishedAt === undefined ? null : timing.finishedAt - finalInput.inputEpochMs }));
          summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTarget: result.lastTarget, initial, preparation, interaction: since(before), targetHttp };
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
        } finally { await context.close(); }
      }
      if (scenario === 'all') {
        const { context, page } = await openPage();
        try {
          const cdp = await context.newCDPSession(page);
          await quiet(page);
          await cdp.send('HeapProfiler.collectGarbage'); initialHeap = await cdp.send('Runtime.getHeapUsage');
          // Visit the full day to populate the same compressed tile cache in both variants.
          for (let index = 1; index < frameCount; index++) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
          async function steps(key: string) {
            const rows: Sample[] = [], before = count();
            let index = await page.evaluate(() => window.bench.snapshot().selectedIndex), direction = -1;
            for (let count = 0; count < repeats; count++) {
              if (index === 0) direction = 1; else if (index === frameCount - 1) direction = -1;
              index += direction; rows.push(await page.evaluate(index => window.bench.select(index), index)); await quiet(page);
            }
            samples[key] = rows; summary[key] = { ...summarize(rows), ...since(before) };
          }
          await steps('warmSteps');
          for (const intervalMs of [120, 60]) {
            await page.evaluate(() => window.bench.select(0)); await quiet(page);
            const before = count(), result = await page.evaluate(({ interval, length }) => window.bench.drag(Array.from({ length }, (_, index) => index + 1), interval), { interval: intervalMs, length: frameCount - 1 });
            const key = `warmDay${intervalMs}ms`;
            samples[key] = result.samples; summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTarget: result.lastTarget, ...since(before) };
            await quiet(page);
          }
          await page.locator('#map').click({ position: { x: 1100, y: 500 } });
          await page.waitForFunction(() => { const card = document.querySelector<HTMLElement>('#point-card'); return card && !card.hidden && card.ariaBusy === 'false' && !!document.querySelector('#point-body')?.childElementCount; });
          await steps('warmStepsWithPoint');
          const layerStart = count(), layerSamples: Sample[] = [];
          for (const reference of ['msl', 'agl'] as const) { layerSamples.push(await page.evaluate(value => window.bench.layer(value), reference)); await quiet(page); }
          samples.layerSwitch = layerSamples; summary.layerSwitch = { ...summarize(layerSamples), ...since(layerStart) };
          for (let round = 0; round < 8; round++) {
            await page.evaluate(longitude => window.bench.pan(longitude), -100 + (round % 2 ? 0 : 5)); await quiet(page);
            for (const index of [0, Math.floor(frameCount / 2), frameCount - 1]) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
            memoryPlateau.push({ round, ...await page.evaluate(() => window.bench.snapshot()) });
          }
          await cdp.send('HeapProfiler.collectGarbage'); finalHeap = await cdp.send('Runtime.getHeapUsage');
          finalEnvironment = await page.evaluate(() => window.bench.snapshot());
          await page.screenshot({ path: output.replace(/\.json$/, `-${name}.png`) });
        } finally { await context.close(); }
      }
      if (sourceSha256 !== await sourceHash(codeRoot)) throw new Error('Benchmark sources changed during the run; repeat with stable sources');
      if (errors.length) throw new Error(errors.join('\n'));
      results.push({ name, revision: name === 'baseline' ? baselineRevision : 'working-tree', sourceSha256, environment, finalEnvironment, summary, samples, memoryPlateau,
        totalRequests: requests, uniqueTileURLs: urls.size, totalTileBytes: bytes, overviewRequests, overviewBytes, maxImageReadyMs, httpVersions: [...protocols], peakHTTPRequests: peakActive, initialHeap, finalHeap });
      console.log(JSON.stringify({ name, summary, finalEnvironment, peakHTTPRequests: peakActive }));
    } finally { await vite.close(); hmr.closeAllConnections(); await new Promise<void>(resolve => hmr.close(() => resolve())); for (const session of sessions) session.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  const harnessSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(join(root, 'apps/preview/bench.ts'))).update(await readFile(join(root, 'scripts/preview-pixels.ts'))).digest('hex');
  await writeFile(output, JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'Nine framebuffer probes at 2%, 50% and 98% of both viewport axes validate selected time, layer and Web Mercator position. First-correct and fully-detailed timings are separate. After-idle preparation is capped at 10s and all preparation requests/bytes are counted.',
    tileDelayMs, repeats, scenario, frameCount, opacity, transparent, viewport: { width: 1920, height: 1080, dpr: 1 }, sourceDirectories, harnessSha256,
    memoryScope: 'GPU texture allocations include mip levels/pool. Weak native-pixel tracking counts unclosed/unfinished ImageBitmap decodes and canvas backing dimensions; pending Blob decode size assumes the fixture 256px tile. Driver overhead, workers and default framebuffer remain outside these logical byte counts. CDP heap follows forced GC.',
    channel: channel || 'headless-shell', browser: browser.version(), results }, null, 2) + '\n');
  console.log(`Report: ${output}`);
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
