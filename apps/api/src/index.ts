import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import {
  CELL_BYTES,
  GFS_GRID,
  LAYER_IDS,
  LIFT_COLORS,
  LIFT_RENDER_STYLE,
  MODEL_IDS,
  PALETTES,
  SAMPLE_STATUSES,
  STATUS_OUTSIDE,
  compactSource,
  computeFreshness,
  isCovered,
  isPaletteId,
  isTileCovered,
  latestSchema,
  manifestSchema,
  modelPointerSchema,
  paletteBinLabel,
  paletteSchema,
  sampleResponseSchema,
  type CoverageMask,
  type LayerId,
  type Manifest,
  type ModelId,
  type ModelPointer
} from '@av/contracts';
import { cellsFromRange, planSample, sampleCells } from '@av/forecast';
import output from '../../../packages/contracts/coverage/output.bin';
import halo from '../../../packages/contracts/coverage/halo.bin';
import tiles from '../../../packages/contracts/coverage/tiles.bin';
import witnessData from '../../../packages/contracts/coverage/manifest.json';
import { readTile } from './pmtiles';

type Env = {
  Bindings: {
    BUCKET: R2Bucket;
    SAMPLE_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
    AV_LOCAL_DEVELOPMENT?: string;
  };
};
type WaitContext = { waitUntil(promise: Promise<unknown>): void };

const mask: CoverageMask = {
  grid: GFS_GRID,
  output: new Uint8Array(output),
  halo: new Uint8Array(halo),
  tiles: new Uint8Array(tiles),
  maxZoom: 5
};
const pointerCache = new WeakMap<R2Bucket, Map<ModelId, { pointer: ModelPointer; until: number }>>();
const manifestCache = new WeakMap<R2Bucket, Map<string, Manifest>>();
const MAX_CACHED_MANIFESTS = 64;
const IMMUTABLE_TTL = 86400;
const blank = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAABFUlEQVR42u3BMQEAAADCoPVP7WsIoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAeAMBPAAB2ClDBAAAAABJRU5ErkJggg=='
  ),
  c => c.charCodeAt(0)
);

class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
  }
}

function fail(status: number, code: string, detail: string): never {
  throw new Problem(status, code, detail);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
function validateId(value: string): string {
  if (!idPattern.test(value)) fail(400, 'invalid-parameter', 'Invalid resource identifier');
  return value;
}

function modelId(value: string): ModelId {
  if (!(MODEL_IDS as readonly string[]).includes(value)) fail(404, 'unknown-model', 'Unknown model');
  return value as ModelId;
}

function layerId(value: string): LayerId {
  if (!(LAYER_IDS as readonly string[]).includes(value)) fail(404, 'unknown-layer', 'Unknown layer');
  return value as LayerId;
}

function ttl(expiresAt: string): number {
  return Math.max(0, Math.min(IMMUTABLE_TTL, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
}

function ensureLive(expiresAt: string): void {
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    fail(404, 'not-retained', 'Build is expired or not retained');
  }
}

const fileWitness = z.object({ bytes: z.number().int().positive(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const witnessSchema = z.object({ id: z.literal('soaring-land-v1'), output: fileWitness, halo: fileWitness, tiles: fileWitness });
const witnessPromise: Promise<string | null> = (async () => {
  const bytes = witnessData as unknown as ArrayBuffer;
  if (!(bytes instanceof ArrayBuffer)) fail(503, 'coverage-unavailable', 'Invalid bundled coverage witness');
  const witness = witnessSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
  if (!witness.success) fail(503, 'coverage-unavailable', 'Invalid bundled coverage witness');
  const digest = async (data: ArrayBuffer) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), b => b.toString(16).padStart(2, '0')).join('');
  for (const [data, expected] of [
    [output, witness.data.output],
    [halo, witness.data.halo],
    [tiles, witness.data.tiles]
  ] as const) {
    if (data.byteLength !== expected.bytes || (await digest(data)) !== expected.sha256) {
      fail(503, 'coverage-unavailable', 'Bundled coverage does not match witness');
    }
  }
  return digest(bytes);
})().catch(() => null);

async function pointer(bucket: R2Bucket, model: ModelId, refresh = false): Promise<ModelPointer> {
  let entries = pointerCache.get(bucket);
  if (!entries) {
    entries = new Map();
    pointerCache.set(bucket, entries);
  }
  const cached = entries.get(model);
  if (!refresh && cached && cached.until > Date.now()) return cached.pointer;
  const object = await bucket.get(`catalog/${model}/latest.json`);
  if (!object) fail(503, 'publication-unavailable', `No publication available for ${model}`);
  let raw: unknown;
  try {
    raw = await object.json();
  } catch {
    return fail(503, 'publication-invalid', 'Invalid model pointer');
  }
  const result = modelPointerSchema.safeParse(raw);
  if (!result.success || result.data.model !== model) fail(503, 'publication-invalid', 'Invalid model pointer');
  entries.set(model, { pointer: result.data, until: Date.now() + 15_000 });
  return result.data;
}

async function admit(bucket: R2Bucket, model: ModelId, build: string) {
  validateId(build);
  let current = await pointer(bucket, model);
  let entry = current.retained.find(item => item.buildId === build);
  if (!entry) {
    current = await pointer(bucket, model, true);
    entry = current.retained.find(item => item.buildId === build);
  }
  if (!entry) return fail(404, 'not-retained', 'Build is expired or not retained');
  ensureLive(entry.expiresAt);
  if (entry.manifestKey !== `builds/${model}/${build}/manifest.json`) fail(503, 'publication-invalid', 'Invalid manifest key');
  return entry;
}

async function manifest(
  bucket: R2Bucket,
  model: ModelId,
  build: string,
  entry: Awaited<ReturnType<typeof admit>>
): Promise<Manifest> {
  let entries = manifestCache.get(bucket);
  if (!entries) {
    entries = new Map();
    manifestCache.set(bucket, entries);
  }
  const cacheKey = `${model}/${build}`;
  let m = entries.get(cacheKey);
  if (!m) {
    const object = await bucket.get(entry.manifestKey);
    if (!object) fail(503, 'publication-incomplete', 'Manifest is missing');
    let raw: unknown;
    try {
      raw = await object.json();
    } catch {
      return fail(503, 'publication-invalid', 'Invalid manifest');
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) fail(503, 'publication-invalid', 'Invalid manifest');
    m = parsed.data;
  }
  if (m.model !== model || m.buildId !== build || m.expiresAt !== entry.expiresAt || m.cycle !== entry.cycle) {
    entries.delete(cacheKey);
    fail(503, 'publication-invalid', 'Manifest does not match retained entry');
  }
  ensureLive(m.expiresAt);
  if (
    model !== 'gfs' ||
    m.coverage.id !== 'soaring-land-v1' ||
    m.coverage.hash !== (await witnessPromise) ||
    m.coverage.maxZoom > mask.maxZoom ||
    (Object.keys(GFS_GRID) as (keyof typeof GFS_GRID)[]).some(key => m.grid[key] !== GFS_GRID[key])
  ) {
    entries.delete(cacheKey);
    fail(503, 'coverage-unavailable', 'Coverage for this publication is unavailable');
  }
  if (!entries.has(cacheKey)) {
    if (entries.size >= MAX_CACHED_MANIFESTS) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
    entries.set(cacheKey, m);
  }
  return m;
}

function artifact(m: Manifest, layer: LayerId, frame: string) {
  validateId(frame);
  if (!m.layers.includes(layer) || !m.frames.some(f => f.id === frame)) fail(404, 'unknown-resource', 'Unknown frame or layer');
  const item = m.artifacts.find(a => a.layer === layer && a.frame === frame);
  if (!item) fail(503, 'publication-incomplete', 'Artifact missing from manifest');
  const prefix = `builds/${m.model}/${m.buildId}`;
  if (item.tilesKey !== `${prefix}/${layer}/${frame}.pmtiles` || item.samplesKey !== `${prefix}/samples/${layer}/${frame}.bin`) {
    fail(503, 'publication-invalid', 'Invalid artifact key');
  }
  return item;
}

function query(url: URL, allowed: string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) fail(400, 'invalid-query', 'Unknown or duplicate query parameter');
    seen.add(key);
  }
}

function response(body: BodyInit | null, type: string, expiresAt?: string, etag?: string): Response {
  if (expiresAt) ensureLive(expiresAt);
  const headers = new Headers({
    'content-type': type,
    'cache-control': expiresAt ? `public, max-age=${ttl(expiresAt)}` : 'no-store'
  });
  if (etag) headers.set('etag', `"${etag}"`);
  return new Response(body, { headers });
}

function json(value: unknown, expiresAt?: string, etag?: string): Response {
  return response(JSON.stringify(value), 'application/json; charset=utf-8', expiresAt, etag);
}

function finish(request: Request, res: Response, expiresAt?: string): Response {
  if (expiresAt) ensureLive(expiresAt);
  const headers = new Headers(res.headers);
  if (expiresAt) headers.set('cache-control', `public, max-age=${ttl(expiresAt)}`);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'ETag, Cache-Control');
  if (
    res.status === 200 &&
    headers.has('etag') &&
    request.headers
      .get('if-none-match')
      ?.split(',')
      .map(x => x.trim())
      .includes(headers.get('etag')!)
  ) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

async function cached(request: Request, expiresAt: string, ctx: WaitContext, build: () => Promise<Response>): Promise<Response> {
  ensureLive(expiresAt);
  const cache = typeof caches !== 'undefined' ? (caches as CacheStorage & { default?: Cache }).default : undefined;
  const key = new Request(request.url, { method: 'GET' });
  const hit = await cache?.match(key);
  if (hit) return finish(request, hit, expiresAt);
  const result = await build();
  ensureLive(expiresAt);
  if (cache && result.status === 200 && ttl(expiresAt) > 0) ctx.waitUntil(cache.put(key, result.clone()));
  return finish(request, result, expiresAt);
}

function view(m: Manifest, origin: string) {
  return {
    manifest: m,
    templates: Object.fromEntries(
      m.layers.map(layer => [layer, `${origin}/tiles/${m.model}/${m.buildId}/${layer}/{frame}/{z}/{x}/{y}.png`])
    ),
    bounds: [-180, -55, 180, 65],
    maxNativeZoom: m.coverage.maxZoom,
    palettes: m.palettes.filter(isPaletteId).map(id => id === 'lift' && m.tool.liftRenderStyle !== LIFT_RENDER_STYLE ? { ...PALETTES.lift, noLiftColor: LIFT_COLORS[0] } : PALETTES[id]),
    coverage: { ...m.coverage, tileBits: Array.from(mask.tiles) }
  };
}

function validIp(ip: string): boolean {
  const ipv4 = (value: string) => {
    const parts = value.split('.');
    return parts.length === 4 && parts.every(part => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
  };
  if (!ip.includes(':')) return ipv4(ip);
  if (ip.length > 45 || !/^[0-9a-f:.]+$/i.test(ip)) return false;
  if (ip.includes('.') && !ipv4(ip.slice(ip.lastIndexOf(':') + 1))) return false;
  try {
    new URL(`http://[${ip}]/`);
    return true;
  } catch {
    return false;
  }
}

const app = new OpenAPIHono<Env>({
  defaultHook: result => {
    if (!result.success) {
      return new Response(
        JSON.stringify({
          type: 'urn:windy-av:invalid-parameter',
          title: 'invalid-parameter',
          status: 400,
          detail: 'Invalid request parameters'
        }),
        { status: 400, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' } }
      );
    }
  }
});

app.use('/v1/models/:model/runs/:buildId/sample', async (c, next) => {
  const ip = c.req.header('CF-Connecting-IP');
  const key = ip === undefined && c.env.AV_LOCAL_DEVELOPMENT === 'true' ? 'localhost' : ip;
  if (!key || (ip !== undefined && !validIp(ip)) || !c.env.SAMPLE_RATE_LIMITER) {
    fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  }
  let allowed: { success: boolean };
  try {
    allowed = await c.env.SAMPLE_RATE_LIMITER.limit({ key });
  } catch {
    return fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  }
  if (typeof allowed?.success !== 'boolean') fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  if (!allowed.success) fail(429, 'rate-limit-exceeded', 'Sample request rate exceeded');
  await next();
});

const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string() });
const problemResponses = {
  400: { description: 'Invalid request', content: { 'application/problem+json': { schema: problemSchema } } },
  404: { description: 'Unknown or not-retained resource', content: { 'application/problem+json': { schema: problemSchema } } },
  429: { description: 'Sample selection or request rate exceeds limits', content: { 'application/problem+json': { schema: problemSchema } } },
  503: { description: 'Publication, coverage, archive or rate limiter unavailable', content: { 'application/problem+json': { schema: problemSchema } } }
};
const param = z.string().min(1).max(128);

function requiredParam(c: Context<Env>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) fail(400, 'invalid-parameter', 'Invalid request parameters');
  return value;
}

function registerJsonRoute(
  path: string,
  honoPath: string,
  params: Record<string, z.ZodTypeAny>,
  queries: Record<string, z.ZodTypeAny>,
  schema: z.ZodTypeAny,
  handler: (c: Context<Env>, url: URL) => Promise<Response> | Response
): void {
  const paramValidator = z.object(params);
  const queryValidator = z.object(queries);
  const route = createRoute({
    method: 'get',
    path,
    request: { params: paramValidator, query: queryValidator },
    responses: {
      200: { description: 'Successful response', content: { 'application/json': { schema } } },
      ...problemResponses
    }
  });
  app.openAPIRegistry.registerPath(route);
  app.get(honoPath, async c => {
    const url = new URL(c.req.url);
    query(url, Object.keys(queries));
    if (!paramValidator.safeParse(c.req.param()).success) {
      fail(400, 'invalid-parameter', 'Invalid request parameters');
    }
    return handler(c, url);
  });
}

registerJsonRoute('/healthz', '/healthz', {}, {}, z.object({ ok: z.boolean() }), () => json({ ok: true }));

registerJsonRoute(
  '/v1/catalog',
  '/v1/catalog',
  {},
  {},
  z.object({ models: z.array(z.object({ model: z.string(), available: z.boolean() }).passthrough()) }),
  async c => {
    const models = await Promise.all(
      MODEL_IDS.map(async model => {
        try {
          const ptr = await pointer(c.env.BUCKET, model);
          const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId);
          const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry);
          const freshness = computeFreshness(m);
          return {
            model,
            available: true,
            latest: `/v1/models/${model}/latest`,
            cycle: m.cycle,
            expiresAt: m.expiresAt,
            coverage: m.coverage,
            ageSeconds: freshness.ageSeconds,
            freshness
          };
        } catch (e) {
          return { model, available: false, error: e instanceof Problem ? e.code : 'publication-unavailable' };
        }
      })
    );
    return json({ models });
  }
);

registerJsonRoute(
  '/v1/models/{model}/latest',
  '/v1/models/:model/latest',
  { model: param },
  { expand: z.enum(['manifest']).optional() },
  latestSchema,
  async (c, url) => {
    if (url.searchParams.has('expand') && url.searchParams.get('expand') !== 'manifest') {
      fail(400, 'invalid-query', 'Invalid expand');
    }
    const model = modelId(requiredParam(c, 'model'));
    const ptr = await pointer(c.env.BUCKET, model);
    const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId);
    const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry);
    const compactManifest = { ...m, source: compactSource(m.source) };
    return json({
      pointer: ptr,
      ...(url.searchParams.has('expand') ? view(compactManifest, url.origin) : {}),
      freshness: computeFreshness(m)
    });
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs',
  '/v1/models/:model/runs',
  { model: param },
  {},
  z.object({ model: z.string(), retained: modelPointerSchema.shape.retained }),
  async c => {
    const model = modelId(requiredParam(c, 'model'));
    const ptr = await pointer(c.env.BUCKET, model);
    return json({ model, retained: ptr.retained.filter(item => Date.parse(item.expiresAt) > Date.now()) });
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}',
  '/v1/models/:model/runs/:buildId',
  { model: param, buildId: param },
  {},
  manifestSchema,
  async c => {
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const entry = await admit(c.env.BUCKET, model, buildId);
    const m = await manifest(c.env.BUCKET, model, buildId, entry);
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => json(m, m.expiresAt, `manifest-${m.buildId}`));
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/layers/{layer}/{frame}/tilejson.json',
  '/v1/models/:model/runs/:buildId/layers/:layer/:frame/tilejson.json',
  { model: param, buildId: param, layer: param, frame: param },
  {},
  z.object({
    tilejson: z.literal('3.0.0'),
    name: z.string(),
    tiles: z.array(z.string()),
    minzoom: z.number(),
    maxzoom: z.number(),
    bounds: z.array(z.number())
  }),
  async (c, url) => {
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const layer = layerId(requiredParam(c, 'layer'));
    const frame = requiredParam(c, 'frame');
    const entry = await admit(c.env.BUCKET, model, buildId);
    const m = await manifest(c.env.BUCKET, model, buildId, entry);
    artifact(m, layer, frame);
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () =>
      json(
        {
          tilejson: '3.0.0',
          name: `${layer} ${frame}`,
          tiles: [`${url.origin}/tiles/${model}/${m.buildId}/${layer}/${frame}/{z}/{x}/{y}.png`],
          minzoom: 0,
          maxzoom: m.coverage.maxZoom,
          bounds: [-180, -55, 180, 65]
        },
        m.expiresAt,
        `tilejson-${m.buildId}-${layer}-${frame}`
      )
    );
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/sample',
  '/v1/models/:model/runs/:buildId/sample',
  { model: param, buildId: param },
  { lat: z.string(), lon: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  sampleResponseSchema,
  async (c, url) => {
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const entry = await admit(c.env.BUCKET, model, buildId);
    const m = await manifest(c.env.BUCKET, model, buildId, entry);
    return sample(c.req.raw, c.env.BUCKET, c.executionCtx, m, url);
  }
);

app.openAPIRegistry.registerPath(
  createRoute({
    method: 'get',
    path: '/v1/palettes/{id}.json',
    request: { params: z.object({ id: param }), query: z.object({}) },
    responses: {
      200: { description: 'Palette metadata', content: { 'application/json': { schema: paletteSchema } } },
      ...problemResponses
    }
  })
);
app.openAPIRegistry.registerPath(
  createRoute({
    method: 'get',
    path: '/v1/palettes/{id}.svg',
    request: { params: z.object({ id: param }), query: z.object({}) },
    responses: {
      200: { description: 'Palette legend SVG', content: { 'image/svg+xml': { schema: z.string() } } },
      ...problemResponses
    }
  })
);
app.get('/v1/palettes/:asset', async c => {
  const url = new URL(c.req.url);
  query(url, []);
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(json|svg)$/.exec(c.req.param('asset'));
  if (!match) fail(400, 'invalid-parameter', 'Invalid palette path');
  const [, id, format] = match;
  if (!isPaletteId(id)) fail(404, 'unknown-palette', 'Unknown palette');
  const palette = PALETTES[id];
  const expiry = new Date(Date.now() + 31536000000).toISOString();
  if (format === 'json') return json(palette, expiry, `palette-${id}-v2`);
  const items: { color: string; text: string }[] = palette.colors.map((color, i) => ({
    color,
    text: `${paletteBinLabel(palette.edges, palette.colors.length, i)} ${palette.units}`
  }));
  if ('noLiftColor' in palette) items.push({ color: palette.noLiftColor, text: 'no usable lift (transparent)' });
  if ('transparentBelow' in palette) items.push({ color: 'none', text: `&lt; ${palette.transparentBelow} ${palette.units} (transparent)` });
  const rows = items
    .map((item, i) => `<rect x="0" y="${i * 24}" width="24" height="24" fill="${item.color}"/><text x="32" y="${i * 24 + 17}">${item.text}</text>`)
    .join('');
  return response(`<svg xmlns="http://www.w3.org/2000/svg" width="220" height="${items.length * 24}">${rows}</svg>`, 'image/svg+xml', expiry, `palette-${id}-v2`);
});

const tileParamSchema = z.object({ model: param, buildId: param, layer: param, frame: param, z: param, x: param, y: param });
app.openAPIRegistry.registerPath(
  createRoute({
    method: 'get',
    path: '/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.png',
    request: { params: tileParamSchema, query: z.object({}) },
    responses: {
      200: { description: 'Rendered PNG tile', content: { 'image/png': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } },
      ...problemResponses
    }
  })
);
app.get('/tiles/:model/:buildId/:layer/:frame/:z/:x/:filename', async c => {
  const url = new URL(c.req.url);
  query(url, []);
  const match = /^([0-9]+)\.png$/.exec(c.req.param('filename'));
  if (!match) fail(400, 'invalid-tile', 'Invalid tile filename');
  const p = { ...c.req.param(), y: match[1] };
  if (!tileParamSchema.safeParse(p).success) fail(400, 'invalid-parameter', 'Invalid request parameters');
  const model = modelId(p.model);
  const entry = await admit(c.env.BUCKET, model, p.buildId);
  const m = await manifest(c.env.BUCKET, model, p.buildId, entry);
  const layer = layerId(p.layer);
  const a = artifact(m, layer, p.frame);
  if (![p.z, p.x, p.y].every(v => /^(0|[1-9][0-9]*)$/.test(v))) fail(400, 'invalid-tile', 'Invalid tile coordinates');
  const z = Number(p.z),
    x = Number(p.x),
    y = Number(p.y);
  if (!Number.isSafeInteger(z) || z > m.coverage.maxZoom || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x >= 2 ** z || y >= 2 ** z) {
    fail(400, 'invalid-tile', 'Tile address out of range');
  }
  return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => {
    const data = isTileCovered(mask, z, x, y) ? await readTile(c.env.BUCKET, a.tilesKey, z, x, y) : blank;
    return response(data, 'image/png', m.expiresAt, `${a.tilesSha256}-${z}-${x}-${y}`);
  });
});

async function sample(request: Request, bucket: R2Bucket, ctx: WaitContext, m: Manifest, url: URL): Promise<Response> {
  const coordinate = (name: string, min: number, max: number) => {
    const value = url.searchParams.get(name);
    if (value === null || value.trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      fail(400, 'invalid-query', `Invalid ${name}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, 'invalid-query', `Invalid ${name}`);
    return Object.is(n, -0) ? 0 : n;
  };
  const lat = coordinate('lat', -90, 90),
    lon = coordinate('lon', -180, 180);
  const requested = url.searchParams.get('frame');
  const frameIds = requested === 'all' ? m.frames.map(f => f.id) : requested === null ? [m.frames[0].id] : requested.split(',');
  const layers = url.searchParams.get('layers')?.split(',') ?? [...m.layers];
  if (frameIds.length > 8 || layers.length > 3) fail(429, 'sample-limit', 'Select at most eight frames and three layers');
  if (!frameIds.length || !layers.length || new Set(frameIds).size !== frameIds.length || new Set(layers).size !== layers.length) {
    fail(400, 'invalid-query', 'Select distinct frames and layers');
  }
  const selectedLayers = layers.map(layerId).sort();
  const frames = frameIds
    .map(id => {
      const f = m.frames.find(frame => frame.id === id);
      if (!f) return fail(404, 'unknown-frame', 'Unknown frame');
      return f;
    })
    .sort((a, b) => a.validTime.localeCompare(b.validTime));
  const jobs = frames.flatMap(frame => selectedLayers.map(layer => ({ frame, layer, artifact: artifact(m, layer, frame.id) })));
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('lat', String(lat));
  canonical.searchParams.set('lon', String(lon));
  canonical.searchParams.set('frame', frames.map(f => f.id).join(','));
  canonical.searchParams.set('layers', selectedLayers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers });
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const outside = !isCovered(mask, lat, lon);
    const plan = outside ? null : planSample(m.grid, lat, lon);
    const values = new Map<string, { value: number | null; status: number; support: number; interpolated: boolean }>();
    let cursor = 0;
    async function worker() {
      for (;;) {
        const job = jobs[cursor++];
        if (!job) return;
        let value = { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false } as {
          value: number | null;
          status: number;
          support: number;
          interpolated: boolean;
        };
        if (plan) {
          const { offset, length } = plan.byteRange;
          const size = m.grid.width * m.grid.height * CELL_BYTES;
          if (
            !Number.isSafeInteger(size) ||
            !Number.isSafeInteger(offset) ||
            !Number.isSafeInteger(length) ||
            offset < 0 ||
            length <= 0 ||
            offset + length > size ||
            length > 2 * m.grid.width * CELL_BYTES
          ) {
            fail(503, 'publication-invalid', 'Invalid sample range');
          }
          const object = await bucket.get(job.artifact.samplesKey, { range: { offset, length } });
          if (!object || !('body' in object) || object.size !== size) fail(503, 'publication-incomplete', 'Sample array missing or invalid');
          const bytes = new Uint8Array(await object.arrayBuffer());
          if (bytes.byteLength !== length) fail(503, 'publication-incomplete', 'Incomplete sample range');
          value = sampleCells(plan, cellsFromRange(plan, bytes), job.layer);
        }
        values.set(`${job.frame.id}/${job.layer}`, value);
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
    const result = {
      model: m.model,
      buildId: m.buildId,
      lat,
      lon,
      method: m.method,
      source: compactSource(m.source),
      coverage: m.coverage,
      expiresAt: m.expiresAt,
      frames: frames.map(frame => ({
        ...frame,
        layers: Object.fromEntries(
          selectedLayers.map(layer => {
            const value = values.get(`${frame.id}/${layer}`)!;
            return [layer, { ...value, status: SAMPLE_STATUSES[value.status] }];
          })
        )
      }))
    };
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toString()));
    const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return json(result, m.expiresAt, `sample-${tag}`);
  });
}

app.openAPIRegistry.registerPath({ method: 'get', path: '/openapi.json', responses: { 200: { description: 'OpenAPI 3.1 document' } } });
app.openAPIRegistry.registerPath({ method: 'get', path: '/docs', responses: { 200: { description: 'Interactive API documentation' } } });
app.doc('/openapi.json', { openapi: '3.1.0', info: { title: 'Aviation Forecast Layers API', version: '1.0.0' } });
app.get('/docs', c =>
  c.html(
    '<!doctype html><html><head><title>Aviation Forecast Layers API</title></head><body><h1>Aviation Forecast Layers API</h1><p><a href="/openapi.json">OpenAPI document</a></p><script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script><div id="swagger-ui"></div><script>SwaggerUIBundle({url:"/openapi.json",dom_id:"#swagger-ui"})</script></body></html>'
  )
);
app.notFound(() => {
  throw new Problem(404, 'not-found', 'Route not found');
});
app.onError((error, c) => {
  if (!(error instanceof Problem)) {
    console.error('Unhandled API error', {
      method: c.req.method,
      path: c.req.path,
      params: c.req.param(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
  }
  const problem = error instanceof Problem ? error : new Problem(503, 'publication-unavailable', 'Publication or archive unavailable');
  return new Response(
    JSON.stringify({ type: `urn:windy-av:${problem.code}`, title: problem.code, status: problem.status, detail: problem.message }),
    { status: problem.status, headers: { 'content-type': 'application/problem+json; charset=utf-8', 'cache-control': 'no-store' } }
  );
});

export default {
  async fetch(request: Request, env: Env['Bindings'], ctx: WaitContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': 'If-None-Match',
          'access-control-max-age': '86400'
        }
      });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return finish(
        request,
        new Response(
          JSON.stringify({
            type: 'urn:windy-av:method-not-allowed',
            title: 'method-not-allowed',
            status: 405,
            detail: 'Only GET and HEAD are supported'
          }),
          { status: 405, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', allow: 'GET, HEAD, OPTIONS' } }
        )
      );
    }
    const url = new URL(request.url);
    if (url.pathname.includes('%')) {
      return finish(
        request,
        new Response(
          JSON.stringify({
            type: 'urn:windy-av:invalid-parameter',
            title: 'invalid-parameter',
            status: 400,
            detail: 'Encoded path segments are not canonical'
          }),
          { status: 400, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } }
        )
      );
    }
    if (['/docs', '/openapi.json'].includes(url.pathname) && url.search) {
      return finish(
        request,
        new Response(
          JSON.stringify({ type: 'urn:windy-av:invalid-query', title: 'invalid-query', status: 400, detail: 'Unknown query parameter' }),
          { status: 400, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } }
        )
      );
    }
    const req = request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request;
    return finish(request, await app.fetch(req, env, ctx as Parameters<typeof app.fetch>[2]));
  }
};
