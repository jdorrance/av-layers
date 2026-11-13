import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { chromium } from 'playwright';
import { fixtureBuild } from '../tests/forecast-fixture.ts';
import { encodeWebp } from '../apps/batch/src/webp.ts';
import type { LayerId } from '@av/contracts/layers';

const root = resolve(fileURLToPath(new URL('..',import.meta.url)));
const args = process.argv.slice(2);
const option = (name: string,fallback: string) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i+1]; };
const baseline = option('--baseline','origin/main'), repeats = Number(option('--repeats','30')), tileDelayMs = Number(option('--delay-ms','40'));
const output = resolve(option('--out','output/preview-layer-bench.json'));
const channel = option('--channel','');
await mkdir(resolve(output,'..'),{recursive:true});
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 200 || !Number.isInteger(tileDelayMs) || tileDelayMs < 0 || tileDelayMs > 1000) throw new Error('Invalid benchmark repeat count or tile delay');
const scratch = await mkdtemp(join(tmpdir(),'av-preview-bench-'));
const baselineRoot = join(scratch,'baseline');
await mkdir(baselineRoot);
const archive = execFileSync('git',['archive',baseline,'packages/client/src','apps/preview/src/raster-overlay.ts'],{cwd:root,maxBuffer:8*1024*1024});
execFileSync('tar',['-xf','-','-C',baselineRoot],{input:archive});
await symlink(join(root,'node_modules'),join(baselineRoot,'node_modules'));
const previewRequire = createRequire(join(root,'apps/preview/package.json'));
const maplibre = previewRequire.resolve('maplibre-gl/dist/maplibre-gl.mjs');
const browser = await chromium.launch({ headless:true,...(channel ? {channel} : {}) });
const results = [];
const sourceFiles = ['apps/preview/src/raster-overlay.ts','packages/client/src/client-raster.ts','packages/client/src/client-view.ts'];
async function sourceHash(directory: string) {
  const hash = createHash('sha256');
  for (const path of sourceFiles) hash.update(path).update(await readFile(join(directory,path)));
  return hash.digest('hex');
}
try {
  for (const [name,codeRoot] of [['baseline',baselineRoot],['changed',root]]) {
    const sourceSha256 = await sourceHash(codeRoot);
    let requests = 0, active = 0, peakActive = 0, bytes = 0, lastRequest = 0;
    const requestCounts = new Map<string,number>();
    const urls = new Set<string>(), images = new Map<string,Buffer>();
    for (const layer of ['usable-lift-agl','usable-lift-msl']) for (let frame = 0; frame < 8; frame++) {
      const rgba = new Uint8Array(256*256*4);
      let seed = 12345;
      for (let y = 0; y < 256; y++) for (let x = 0; x < 256; x++) {
        const offset = (y*256+x)*4;
        seed = Math.imul(seed,1664525)+1013904223;
        rgba[offset] = layer === 'usable-lift-agl' ? 40 : 200; rgba[offset+1] = 25+frame*24; rgba[offset+2] = 80+((seed>>>26)&3)*30; rgba[offset+3] = 255;
      }
      images.set(`${layer}/f${String((frame+1)*3).padStart(3,'0')}`,await encodeWebp(rgba));
    }
    const vite = await createVite({ configFile:false,root,cacheDir:join(scratch,name,'vite'),logLevel:'error',server:{middlewareMode:true,fs:{allow:[root,scratch]}},
      resolve:{alias:[{find:'@av/client',replacement:join(codeRoot,'packages/client/src/index.ts')},{find:'maplibre-gl',replacement:maplibre}]},
      plugins:[{name:'benchmark-overlay',enforce:'pre',resolveId(id,importer) { if (id === './src/raster-overlay' && importer?.endsWith('/apps/preview/bench.ts')) return join(codeRoot,'apps/preview/src/raster-overlay.ts'); }}]
    });
    let base = '';
    const build = fixtureBuild({expiresAt:new Date(Date.now()+86400000).toISOString()});
    const server = createServer(async (request,response) => {
      const url = new URL(request.url!,'http://localhost');
      if (url.pathname === '/') { response.setHeader('Content-Type','text/html'); response.end('<!doctype html><html><head><style>html,body,#map{margin:0;width:100%;height:100%}#displayed{position:absolute;top:0;left:0;z-index:2;background:white;color:black}</style></head><body><div id="map"></div><output id="displayed"></output><script type="module" src="/apps/preview/bench.ts"></script></body></html>'); return; }
      if (url.pathname === '/bench/config.json') { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({...build,templates:Object.fromEntries(['usable-lift-agl','usable-lift-msl'].map(layer=>[layer,`${base}/tiles/gfs/${build.manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`]))})); return; }
      if (url.pathname.startsWith('/tiles/')) {
        requests++; active++; peakActive = Math.max(peakActive,active); lastRequest = Date.now(); urls.add(url.pathname);
        const [, , , ,layer,frame] = url.pathname.split('/');
        const key = `${layer}/${frame}`, image = images.get(key);
        requestCounts.set(key,(requestCounts.get(key) ?? 0)+1);
        const cancellation = new AbortController();
        response.once('close',()=>cancellation.abort());
        try {
          await delay(tileDelayMs,undefined,{signal:cancellation.signal});
          if (!image) { response.writeHead(404); response.end(); return; }
          response.writeHead(200,{'content-type':'image/webp','content-length':image.length,'cache-control':'public, max-age=3600, immutable'});
          bytes += image.length; response.end(image);
        } catch (error) { if (!cancellation.signal.aborted) throw error; }
        finally { active--; lastRequest = Date.now(); }
        return;
      }
      vite.middlewares(request,response);
    });
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing listener');
    base = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1});
    const page = await context.newPage(), errors:string[] = [];
    page.on('pageerror',error=>errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    const samples: Record<string,unknown[]> = { cold:[],firstLayerToggle:[],cachedLayerToggle:[],directionalAdjacent:[],boundaryReverse:[],intentPreparedTime:[],scrub:[],pan:[] };
    async function quiet() {
      await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      const deadline = Date.now()+20000;
      while (active || Date.now()-lastRequest < 150 || !await page.evaluate(()=>window.bench.settled())) {
        if (Date.now() > deadline) throw new Error('Tile transport or map did not settle');
        await delay(25);
      }
    }
    async function select(layer: LayerId,frame: string) {
      const before = requests, targetBefore = requestCounts.get(`${layer}/${frame}`) ?? 0;
      const sample = await page.evaluate(({layer,frame})=>window.bench.select(layer,frame),{layer,frame});
      return {...sample,requests:requests-before,targetRequests:(requestCounts.get(`${layer}/${frame}`) ?? 0)-targetBefore};
    }
    try {
      await page.goto(base);
      await page.waitForFunction(()=>!!window.bench);
      await page.evaluate(()=>window.bench.ready);
      await quiet();
      const environment = await page.evaluate(()=>window.bench.snapshot());
      const initialHeap = await cdp.send('Runtime.getHeapUsage');
      samples.cold.push(await select('usable-lift-msl','f024'));
      await quiet();
      await select('usable-lift-agl','f009'); await quiet();
      samples.firstLayerToggle.push(await select('usable-lift-msl','f009')); await quiet();
      for (let i=0;i<repeats;i++) {
        const layer: LayerId = i%2 ? 'usable-lift-msl' : 'usable-lift-agl';
        await page.evaluate(({layer})=>window.bench.prepare(layer,'f009'),{layer}); await quiet();
        samples.cachedLayerToggle.push(await select(layer,'f009')); await quiet();
      }
      await select('usable-lift-agl','f009'); await quiet();
      let frameIndex = 2, direction = 1;
      while (samples.directionalAdjacent.length < repeats) {
        const reversed = frameIndex === 0 || frameIndex === environment.frames.length-1;
        if (reversed) direction *= -1;
        frameIndex += direction;
        samples[reversed ? 'boundaryReverse' : 'directionalAdjacent'].push(await select('usable-lift-agl',environment.frames[frameIndex]));
        await quiet();
      }
      for (let i=0;i<repeats;i++) {
        const frame = environment.frames[(i+5)%environment.frames.length];
        await page.evaluate(({frame})=>window.bench.prepare('usable-lift-agl',frame),{frame}); await quiet();
        samples.intentPreparedTime.push(await select('usable-lift-agl',frame)); await quiet();
      }
      for (let i=0;i<5;i++) {
        const frame = await page.evaluate(() => window.bench.snapshot().displayed?.frame === 'f024' ? 'f021' : 'f024');
        const target = `usable-lift-agl/${frame}`, before = requests, targetBefore = requestCounts.get(target) ?? 0;
        const value = await page.evaluate(async frame => {
          const first = window.bench.select('usable-lift-msl','f003').catch(()=>undefined);
          await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
          const second = window.bench.select('usable-lift-agl',frame);
          await first; return second;
        },frame);
        samples.scrub.push({...value,requests:requests-before,targetRequests:(requestCounts.get(target) ?? 0)-targetBefore}); await quiet();
      }
      for (let i=0;i<5;i++) {
        await page.evaluate(lon=>window.bench.pan(lon),-100+(i%2?0:5)); await quiet();
        samples.pan.push(await select(i%2?'usable-lift-agl':'usable-lift-msl','f009')); await quiet();
      }
      const finalHeap = await cdp.send('Runtime.getHeapUsage');
      if (sourceSha256 !== await sourceHash(codeRoot)) throw new Error('Benchmark sources changed during the run; repeat with stable sources');
      if (errors.length) throw new Error(errors.join('\n'));
      await page.screenshot({path:output.replace(/\.json$/,`-${name}.png`)});
      const summary = Object.fromEntries(Object.entries(samples).map(([scenario,rows])=>{
        const values = rows as {ms:number;requests:number;targetRequests:number;sources:number}[];
        const sorted = values.map(row=>row.ms).sort((a,b)=>a-b);
        return [scenario,{n:rows.length,p50Ms:sorted[Math.floor((sorted.length-1)*0.5)],p95Ms:sorted[Math.ceil(sorted.length*0.95)-1],maxMs:sorted.at(-1),requests:values.reduce((sum,row)=>sum+row.requests,0),targetRequests:values.reduce((sum,row)=>sum+row.targetRequests,0),maxSources:Math.max(...values.map(row=>row.sources))}];
      }));
      results.push({name,revision:name==='baseline'?execFileSync('git',['rev-parse',baseline],{cwd:root,encoding:'utf8'}).trim():'working-tree',sourceSha256,environment,summary,samples,
        totalRequests:requests,uniqueTileURLs:urls.size,totalTileBytes:bytes,peakHTTPRequests:peakActive,initialHeap,finalHeap});
      console.log(JSON.stringify({name,summary,peakHTTPRequests:peakActive}));
    } finally { await context.close(); await vite.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); }
  }
  await mkdir(resolve(output,'..'),{recursive:true});
  await writeFile(output,JSON.stringify({capturedAt:new Date().toISOString(),scope:'RasterOverlay with real MapLibre/WebGL; synthetic patterned WebP tiles; tile latency injected at local HTTP server; ready measured on a later render with five-position framebuffer target-color validation',tileDelayMs,repeats,viewport:{width:1920,height:1080,dpr:1},maxTileCacheSize:16,sourceFiles,memoryScope:'CDP JavaScript/embedder/backing storage; GPU allocations excluded',channel:channel || 'headless-shell',browser:browser.version(),results},null,2)+'\n');
  console.log(`Report: ${output}`);
} finally { await browser.close(); await rm(scratch,{recursive:true,force:true}); }
