import { createServer } from 'node:http';
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

const root = resolve(fileURLToPath(new URL('..', import.meta.url))), args = process.argv.slice(2);
const option = (name: string, fallback: string) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const baseline = option('--baseline', '99cd00a'), repeats = Number(option('--repeats', '30')), tileDelayMs = Number(option('--delay-ms', '40'));
const output = resolve(option('--out', 'output/preview-layer-bench.json')), channel = option('--channel', ''), scenario = option('--scenario', 'all');
const variant = option('--variant', 'both');
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 200 || !Number.isInteger(tileDelayMs) || tileDelayMs < 0 || tileDelayMs > 1000 ||
  !['all', 'cold'].includes(scenario) || !['both', 'baseline', 'changed'].includes(variant)) throw new Error('Invalid benchmark options');
await mkdir(dirname(output), { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), 'av-preview-bench-')), baselineRoot = join(scratch, 'baseline');
const sourceDirectories = ['packages/client/src', 'apps/preview/src'];
await mkdir(baselineRoot);
const baselineRevision = execFileSync('git', ['rev-parse', baseline], { cwd: root, encoding: 'utf8' }).trim();
const archive = execFileSync('git', ['archive', baselineRevision, ...sourceDirectories, 'apps/preview/index.html'], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
execFileSync('tar', ['-xf', '-', '-C', baselineRoot], { input: archive });
await symlink(join(root, 'node_modules'), join(baselineRoot, 'node_modules'));
await symlink(join(root, 'apps/preview/node_modules'), join(baselineRoot, 'apps/preview/node_modules'));
const maplibreDirectory = dirname(createRequire(join(root, 'apps/preview/package.json')).resolve('maplibre-gl/package.json'));
const build = fixtureProfileBuild({ frameHours: Array.from({ length: 24 }, (_, index) => index + 1), mapFrameCount: 24 });
build.manifest.expiresAt = new Date(Date.now() + 86400000).toISOString();
build.expiresAtMs = Date.parse(build.manifest.expiresAt);
const images = new Map<string, Buffer>();
for (const layer of ['usable-lift-agl', 'usable-lift-msl']) for (const [index, frame] of build.manifest.frames.entries()) {
  const rgba = new Uint8Array(256 * 256 * 4);
  let seed = 12345;
  for (let pixel = 0; pixel < 256 * 256; pixel++) {
    seed = Math.imul(seed, 1664525) + 1013904223;
    rgba.set([layer === 'usable-lift-agl' ? 40 : 200, 16 + index * 8, 80 + ((seed >>> 26) & 3) * 30, 255], pixel * 4);
  }
  images.set(`${layer}/${frame.id}`, await encodeWebp(rgba));
}
type Sample = Awaited<ReturnType<PreviewBench['select']>>;
function summarize(samples: Sample[]) {
  const rendered = samples.filter(sample => sample.rendered), sorted = rendered.map(sample => sample.ms).sort((a, b) => a - b);
  return { inputs: samples.length, rendered: rendered.length, superseded: samples.length - rendered.length,
    p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)] ?? null, p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null, maxSources: Math.max(0, ...samples.map(sample => sample.sources)) };
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
    let requests = 0, active = 0, peakActive = 0, bytes = 0, lastRequest = 0, base = '';
    const urls = new Set<string>(), errors: string[] = [];
    const server = createServer(async (request, response) => {
      const url = new URL(request.url!, 'http://localhost');
      const json = (value: unknown) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); };
      try {
        if (url.pathname === '/') {
          response.setHeader('content-type', 'text/html');
          response.end(await vite!.transformIndexHtml(request.url!, await readFile(join(codeRoot, 'apps/preview/index.html'), 'utf8'))); return;
        }
        if (url.pathname === '/bench/config.json') { json({ frames: build.manifest.frames.map(frame => frame.id) }); return; }
        if (url.pathname === '/v1/models/gfs/latest') { json(fixtureLatest(build.manifest, base)); return; }
        if (url.pathname.endsWith('/sample') || url.pathname.endsWith('/profile')) { json(fixturePointFetch(build, `${base}${request.url}`)); return; }
        if (url.pathname.startsWith('/tiles/')) {
          requests++; active++; peakActive = Math.max(peakActive, active); lastRequest = Date.now(); urls.add(url.pathname);
          const [, , , , layer, frame] = url.pathname.split('/'), image = images.get(`${layer}/${frame}`);
          const cancellation = new AbortController();
          response.once('close', () => cancellation.abort());
          try {
            await delay(tileDelayMs, undefined, { signal: cancellation.signal });
            if (!image) { response.writeHead(404); response.end(); return; }
            response.writeHead(200, { 'content-type': 'image/webp', 'content-length': image.length, 'cache-control': 'public, max-age=3600, immutable' });
            bytes += image.length; response.end(image);
          } catch (error) { if (!cancellation.signal.aborted) throw error; }
          finally { active--; lastRequest = Date.now(); }
          return;
        }
        vite!.middlewares(request, response);
      } catch (error) { errors.push(String(error)); response.writeHead(500); response.end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    base = `http://127.0.0.1:${address.port}`;
    const benchEntry = join(root, 'apps/preview/bench.ts');
    const vite = await createVite({ configFile: false, root: join(codeRoot, 'apps/preview'), cacheDir: join(scratch, name, 'vite'), logLevel: 'error',
      server: { middlewareMode: true, fs: { allow: [root, scratch] } }, optimizeDeps: { noDiscovery: true },
      define: { 'import.meta.env.AV_API_BASE': JSON.stringify(base), 'import.meta.env.VITE_OFFLINE_FIXTURE': '"true"' },
      resolve: { alias: [{ find: '@av/client/dom', replacement: join(codeRoot, 'packages/client/src/dom.ts') },
        { find: /^@av\/client$/, replacement: join(codeRoot, 'packages/client/src/index.ts') },
        { find: /^maplibre-gl\//, replacement: `${maplibreDirectory}/` }] },
      plugins: [{ name: 'measure-real-preview', enforce: 'pre', resolveId(id, importer) {
        if (id === 'maplibre-gl' && importer !== benchEntry) return benchEntry;
      } }]
    });
    async function openPage() {
      const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${base}/?model=gfs&ref=agl&opacity=1&lat=40&lon=-100&z=7.15&t=${encodeURIComponent(build.manifest.frames[0].validTime)}`);
      await page.waitForFunction(() => !!window.bench);
      await page.evaluate(() => Promise.race([window.bench.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Initial preview did not render')), 30000))]));
      return { context, page };
    }
    async function quiet(page: Page) {
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      const deadline = Date.now() + 60000;
      while (active || Date.now() - lastRequest < 180 || !await page.evaluate(() => window.bench.settled())) {
        if (Date.now() > deadline) throw new Error('Tile transport or map did not settle');
        await delay(25);
      }
    }
    const samples: Record<string, Sample[]> = {}, summary: Record<string, unknown> = {}, memoryPlateau = [];
    let environment, finalEnvironment, initialHeap, finalHeap;
    try {
      for (const intervalMs of [120, 60]) {
        const { context, page } = await openPage();
        try {
          environment ??= await page.evaluate(() => window.bench.snapshot());
          const before = requests;
          const result = await page.evaluate(interval => window.bench.drag(Array.from({ length: 23 }, (_, index) => index + 1), interval), intervalMs);
          const key = `coldDay${intervalMs}ms`;
          samples[key] = result.samples;
          summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTargetMs: result.lastTargetMs, requests: requests - before };
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
          for (let index = 1; index < 24; index++) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
          async function steps(key: string) {
            const rows: Sample[] = [], before = requests;
            let index = await page.evaluate(() => window.bench.snapshot().selectedIndex), direction = -1;
            for (let count = 0; count < repeats; count++) {
              if (index === 0) direction = 1; else if (index === 23) direction = -1;
              index += direction; rows.push(await page.evaluate(index => window.bench.select(index), index)); await quiet(page);
            }
            samples[key] = rows; summary[key] = { ...summarize(rows), requests: requests - before };
          }
          await steps('warmSteps');
          for (const intervalMs of [120, 60]) {
            await page.evaluate(() => window.bench.select(0)); await quiet(page);
            const before = requests, result = await page.evaluate(interval => window.bench.drag(Array.from({ length: 23 }, (_, index) => index + 1), interval), intervalMs);
            const key = `warmDay${intervalMs}ms`;
            samples[key] = result.samples; summary[key] = { ...summarize(result.samples), staleFramePaints: result.staleFramePaints, lastTargetMs: result.lastTargetMs, requests: requests - before };
            await quiet(page);
          }
          await page.locator('#map').click({ position: { x: 1100, y: 500 } });
          await page.waitForFunction(() => { const card = document.querySelector<HTMLElement>('#point-card'); return card && !card.hidden && card.ariaBusy === 'false' && !!document.querySelector('#point-body')?.childElementCount; });
          await steps('warmStepsWithPoint');
          for (let round = 0; round < 8; round++) {
            await page.evaluate(longitude => window.bench.pan(longitude), -100 + (round % 2 ? 0 : 5)); await quiet(page);
            for (const index of [0, 12, 23]) { await page.evaluate(index => window.bench.select(index), index); await quiet(page); }
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
        totalRequests: requests, uniqueTileURLs: urls.size, totalTileBytes: bytes, peakHTTPRequests: peakActive, initialHeap, finalHeap });
      console.log(JSON.stringify({ name, summary, finalEnvironment, peakHTTPRequests: peakActive }));
    } finally { await vite.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  const harnessSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).update(await readFile(join(root, 'apps/preview/bench.ts'))).digest('hex');
  await writeFile(output, JSON.stringify({ capturedAt: new Date().toISOString(), scope: 'Real preview main.ts, DOM and #time input capture to first render whose five framebuffer pixels match the latest target; cold drags use fresh browser contexts; warm steps settle between inputs; paced drags do not.',
    tileDelayMs, repeats, scenario, viewport: { width: 1920, height: 1080, dpr: 1 }, sourceDirectories, harnessSha256,
    memoryScope: 'Requested live WebGL texture storage including mip levels and MapLibre texture pool; excludes driver overhead, renderbuffers and default framebuffer. CDP heap snapshots follow forced GC.',
    channel: channel || 'headless-shell', browser: browser.version(), results }, null, 2) + '\n');
  console.log(`Report: ${output}`);
} finally { await browser.close(); await rm(scratch, { recursive: true, force: true }); }
