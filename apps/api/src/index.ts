import { OpenAPIHono, createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { nominalGridSpacingMeters, PRODUCTS } from '@av/contracts/models';
import {
  type ProductDefinition,
  LAYER_IDS,
  PALETTES,
  catalogSchema,
  computeFreshness,
  isPaletteId,
  isTileCovered,
  latestV5Schema,
  manifestV5Schema,
  modelPointerSchema,
  paletteSchema,
  provenanceSchema,
  frameProvenanceSchema,
  sampleResponseV5Schema,
  multiPointSampleResponseSchema,
  profileResponseSchema,
  renderedLayers,
  type CatalogModelEntry,
  type LayerId,
  type ModelId,
  type ModelPointer } from '@av/contracts';
import { serveSample, serveSamples } from './sample';
import { serveProfile } from './profile';
import { readTile } from './pmtiles';
import { paletteSvg } from './palette-svg';
import { resolveSparseTiles, sha256 } from './coverage';
import { type RequestMetrics, boundResponse, r2WaitDuration, ResourceLimitError, waitFor, type WaitContext } from './resources';
import { pointer, pointerCacheState, admit, manifest, provenanceReference, servedSource, artifact, readProvenance, readProvenanceFrame } from './publication';
import { Problem, fail, query, response, json, finish, cached, validIp, canceledRequest, handleError } from './http';
import { apiDocs } from './api-docs';

type Env = {
  Bindings: {
    BUCKET: R2Bucket;
    SAMPLE_RATE_LIMITER: { limit(options: { key: string }): Promise<{ success: boolean }> };
    AV_LOCAL_DEVELOPMENT?: string;
    AV_DEPLOYMENT_ID?: string;
    AV_REQUEST_METRICS?: string;
    AV_RESPONSE_CACHE?: string;
  };
};

// Transparent 256 × 256 lossless tile, generated with the batch WebP encoder.
const blank = Uint8Array.from(atob('UklGRiIAAABXRUJQVlA4TBUAAAAv/8A/EAcQEREAUKT//ymi/6n//QcA'), c => c.charCodeAt(0));

function layerId(value: string): LayerId {
  if (!(LAYER_IDS as readonly string[]).includes(value)) fail(404, 'unknown-layer', 'Unknown layer');
  return value as LayerId;
}

export function createApp({ products = Object.fromEntries(PRODUCTS.map(product => [product.modelId, product])) }: { products?: Record<string, ProductDefinition> } = {}) {
let discoveryConfig: Promise<string> | undefined;
async function discovery(c: Context<Env>, build: () => unknown, observed: readonly (ModelPointer | Problem)[], expiries: readonly string[] = [], expiresAt?: string): Promise<Response> {
  const states = observed.map(pointerCacheState), now = Date.now();
  const deadlines = states.map(state => state?.until ?? now);
  for (const expiry of expiries) {
    const deadline = Date.parse(expiry);
    if (deadline > now) deadlines.push(deadline);
  }
  const until = deadlines.length ? Math.min(...deadlines) : now;
  const config = await (discoveryConfig ??= sha256(new TextEncoder().encode(JSON.stringify(products))));
  const representation = `discovery-v2:${config}:${states.map(state => state?.identity ?? 'uncached').join(':')}`;
  return cached(c.req.raw, expiresAt, c.executionCtx, async () => json(build()), representation, until);
}
const modelId = (c: Context<Env>): ModelId => {
  const value = requiredParam(c, 'model');
  if (!Object.hasOwn(products, value)) fail(404, 'unknown-model', 'Unknown model');
  const metrics = (c.executionCtx as WaitContext).metrics;
  if (metrics) metrics.model = value;
  return value;
};
const app = new OpenAPIHono<Env>({
  defaultHook: result => {
    if (!result.success) fail(400, 'invalid-parameter', 'Invalid request parameters');
  }
});

app.use('*', (c, next) => {
  const metrics = (c.executionCtx as WaitContext).metrics;
  const route = routePath(c, -1);
  if (metrics && route && route !== '*') metrics.route = route;
  return next();
});

const pointRateLimit: MiddlewareHandler<Env> = async (c, next) => {
  const { signal } = c.req.raw;
  signal.throwIfAborted();
  const ip = c.req.header('CF-Connecting-IP');
  const key = ip === undefined && c.env.AV_LOCAL_DEVELOPMENT === 'true' ? 'localhost' : ip;
  if (!key || (ip !== undefined && !validIp(ip)) || !c.env.SAMPLE_RATE_LIMITER) {
    fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  }
  let allowed: { success: boolean };
  try {
    allowed = await waitFor(c.env.SAMPLE_RATE_LIMITER.limit({ key }), signal);
  } catch {
    signal.throwIfAborted();
    return fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  }
  if (typeof allowed?.success !== 'boolean') fail(503, 'rate-limit-unavailable', 'Sample rate limit unavailable');
  if (!allowed.success) fail(429, 'rate-limit-exceeded', 'Sample request rate exceeded');
  await next();
};
for (const path of ['sample', 'samples', 'profile']) app.use(`/v1/models/:model/runs/:buildId/${path}`, pointRateLimit);

const problemSchema = z.object({ type: z.string(), title: z.string(), status: z.number(), detail: z.string() });
const problemResponses = {
  400: { description: 'Invalid request', content: { 'application/problem+json': { schema: problemSchema } } },
  404: { description: 'Unknown or not-retained resource', content: { 'application/problem+json': { schema: problemSchema } } },
  409: { description: 'Product unavailable in this retained build', content: { 'application/problem+json': { schema: problemSchema } } },
  429: { description: 'Sample selection or request rate exceeds limits', content: { 'application/problem+json': { schema: problemSchema } } },
  503: { description: 'Publication, coverage, archive or rate limiter unavailable', content: { 'application/problem+json': { schema: problemSchema } } }
};
const param = z.string().min(1).max(128);
const manifestResponseSchema = manifestV5Schema.meta({ id: 'PublishedManifest' });

function requiredParam(c: Context<Env>, name: string): string {
  const value = c.req.param(name);
  if (value === undefined) fail(400, 'invalid-parameter', 'Invalid request parameters');
  return value;
}

function registerJsonRoute(
  path: string,
  params: Record<string, z.ZodTypeAny>,
  queries: Record<string, z.ZodTypeAny>,
  schema: z.ZodTypeAny,
  handler: (c: Context<Env>, url: URL) => Promise<Response> | Response
): void {
  const paramValidator = z.object(params);
  const queryValidator = z.object(queries);
  const route: RouteConfig = createRoute({
    method: 'get',
    path,
    request: { params: paramValidator, query: queryValidator },
    responses: {
      200: { description: 'Successful response', content: { 'application/json': { schema } } },
      ...problemResponses
    }
  });
  app.openapi(route, async c => {
    const url = new URL(c.req.url);
    query(url, Object.keys(queries));
    return handler(c, url);
  });
}

registerJsonRoute('/healthz', {}, {}, z.object({ ok: z.boolean(), deploymentId: z.string().optional() }), c =>
  json({ ok: true, deploymentId: c.env.AV_DEPLOYMENT_ID }));

const catalogMetadata = new Map(Object.entries(products).map(([model, product]) => [model, {
  model, label: product.label,
  nominalDxMeters: nominalGridSpacingMeters(product.grid, product.bounds),
  bounds: [...product.bounds] as [number, number, number, number]
}]));

function unavailableCatalogModel(model: string, error: string): CatalogModelEntry {
  return { ...catalogMetadata.get(model)!, available: false, error };
}

registerJsonRoute(
  '/v1/catalog',
  {},
  {},
  catalogSchema,
  async c => {
    const results = await Promise.all(
      Object.entries(products).map(async ([model, product]): Promise<{ row: CatalogModelEntry; observed: ModelPointer | Problem }> => {
        try {
          const signal = c.req.raw.signal;
          const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx, signal);
          const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId, c.executionCtx, ptr, signal);
          const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry, c.executionCtx, product, signal);
          const freshness = computeFreshness(m);
          return { observed: ptr, row: {
            ...catalogMetadata.get(model)!,
            available: true,
            latest: `/v1/models/${model}/latest`,
            cycle: m.cycle,
            expiresAt: m.expiresAt,
            surfaces: m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
            ageSeconds: freshness.ageSeconds,
            freshness
          } };
        } catch (error) {
          if (error instanceof Problem && ['publication-unavailable', 'publication-invalid', 'publication-incomplete', 'not-retained'].includes(error.code)) {
            if (error.code === 'publication-invalid' || error.code === 'publication-incomplete') console.warn('Catalog publication unavailable', { model, code: error.code });
            return { observed: error, row: unavailableCatalogModel(model, error.code) };
          }
          throw error;
        }
      })
    );
    const expiries = results.flatMap(({ row }) => row.expiresAt === undefined ? [] : [row.expiresAt]);
    const expiresAt = expiries.length ? new Date(Math.min(...expiries.map(Date.parse))).toISOString() : undefined;
    try {
      return await discovery(c, () => ({ models: results.map(({ row }) => row) }), results.map(({ observed }) => observed), expiries, expiresAt);
    } catch (error) {
      if (!(error instanceof Problem) || error.code !== 'not-retained') throw error;
      const now = Date.now();
      const models = results.map(({ row }) => row.expiresAt !== undefined && Date.parse(row.expiresAt) <= now
        ? unavailableCatalogModel(row.model, 'not-retained') : row);
      return finish(c.req.raw, json({ models }));
    }
  }
);

registerJsonRoute(
  '/v1/models/{model}/latest',
  { model: param },
  { expand: z.enum(['manifest']).optional() },
  latestV5Schema.extend({ manifest: manifestResponseSchema.optional() }),
  async (c, url) => {
    const model = modelId(c);
    const signal = c.req.raw.signal;
    const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx, signal);
    const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId, c.executionCtx, ptr, signal);
    const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry, c.executionCtx, products[model], signal);
    const metrics = (c.executionCtx as WaitContext).metrics;
    if (metrics) metrics.buildId = m.buildId;
    const servedManifest = { ...m, source: servedSource(m, url.origin) };
    return discovery(c, () => ({
      pointer: ptr,
      ...(url.searchParams.has('expand') ? {
        manifest: servedManifest,
        templates: Object.fromEntries(renderedLayers(m.layers, m.descriptors.layers).map(layer => [layer, `${url.origin}/tiles/${m.model}/${m.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`]))
      } : {}),
      freshness: computeFreshness(m)
    }), [ptr], ptr.retained.map(item => item.expiresAt), m.expiresAt);
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs',
  { model: param },
  {},
  z.object({ model: z.string(), retained: modelPointerSchema.shape.retained }),
  async c => {
    const model = modelId(c);
    const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx, c.req.raw.signal);
    const retained = ptr.retained.filter(item => Date.parse(item.expiresAt) > Date.now());
    return discovery(c, () => ({ model, retained: ptr.retained.filter(item => Date.parse(item.expiresAt) > Date.now()) }), [ptr], retained.map(item => item.expiresAt));
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}',
  { model: param, buildId: param },
  {},
  manifestResponseSchema,
  async (c, url) => {
    const m = await pinnedManifest(c);
    const served = { ...m, source: servedSource(m, url.origin) };
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => json(served, m.expiresAt, `manifest-${m.buildId}-v2`), 'source-v2');
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/provenance',
  { model: param, buildId: param },
  { frame: param.optional() },
  z.union([provenanceSchema, frameProvenanceSchema]),
  async (c, url) => {
    const m = await pinnedManifest(c);
    const reference = provenanceReference(m);
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => {
      const frame = url.searchParams.get('frame');
      if (frame) {
        const value = await readProvenanceFrame(c.env.BUCKET, m, frame, c.executionCtx, c.req.raw.signal);
        return response(value.bytes as Uint8Array<ArrayBuffer>, 'application/json; charset=utf-8', m.expiresAt, value.sha256);
      }
      const bytes = await readProvenance(c.env.BUCKET, m, reference, c.executionCtx, c.req.raw.signal);
      return response(bytes as Uint8Array<ArrayBuffer>, 'application/json; charset=utf-8', m.expiresAt, reference.sha256);
    });
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/layers/{layer}/{frame}/tilejson.json',
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
    const layer = layerId(requiredParam(c, 'layer'));
    const frame = requiredParam(c, 'frame');
    const m = await pinnedManifest(c);
    artifact(m, layer, frame);
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () =>
      json(
        {
          tilejson: '3.0.0',
          name: `${layer} ${frame}`,
          tiles: [`${url.origin}/tiles/${m.model}/${m.buildId}/${layer}/${frame}/{z}/{x}/{y}.webp`],
          minzoom: 0,
          maxzoom: m.surfaces.find(surface => surface.layers.includes(layer))!.coverage.maxZoom,
          bounds: m.descriptors.bounds
        },
        m.expiresAt,
        `tilejson-${m.buildId}-${layer}-${frame}`
      )
    );
  }
);

async function pinnedManifest(c: Context<Env>) {
  const model = modelId(c), buildId = requiredParam(c, 'buildId');
  const signal = c.req.raw.signal;
  const metrics = (c.executionCtx as WaitContext).metrics;
  const started = performance.now();
  try {
    const entry = await admit(c.env.BUCKET, model, buildId, c.executionCtx, undefined, signal);
    if (metrics) metrics.buildId = buildId;
    return await manifest(c.env.BUCKET, model, buildId, entry, c.executionCtx, products[model], signal);
  } finally { if (metrics) metrics.admitMs = performance.now() - started; }
}

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/sample',
  { model: param, buildId: param },
  { lat: z.string(), lon: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  sampleResponseV5Schema,
  async (c, url) => {
    const m = await pinnedManifest(c);
    return serveSample(c.req.raw, c.env.BUCKET, c.executionCtx, m, url);
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/samples',
  { model: param, buildId: param },
  { points: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  multiPointSampleResponseSchema,
  async (c, url) => serveSamples(c.req.raw, c.env.BUCKET, c.executionCtx, await pinnedManifest(c), url)
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/profile',
  { model: param, buildId: param },
  { lat: z.string(), lon: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  profileResponseSchema,
  async (c, url) => serveProfile(c.req.raw, c.env.BUCKET, c.executionCtx, await pinnedManifest(c), url)
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
const paletteAssets = new Map<string, { bytes: Uint8Array; etag: string }>();
app.get('/v1/palettes/:asset', async c => {
  const url = new URL(c.req.url);
  query(url, []);
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\.(json|svg)$/.exec(c.req.param('asset'));
  if (!match) fail(400, 'invalid-parameter', 'Invalid palette path');
  const [, id, format] = match;
  if (!isPaletteId(id)) fail(404, 'unknown-palette', 'Unknown palette');
  const key = c.req.param('asset');
  let asset = paletteAssets.get(key);
  if (!asset) {
    const palette = PALETTES[id];
    const bytes = new TextEncoder().encode(format === 'json' ? JSON.stringify(palette) : paletteSvg(palette));
    asset = { bytes, etag: await sha256(bytes) };
    paletteAssets.set(key, asset);
  }
  const expiry = new Date(Date.now() + 86400000).toISOString();
  return response(asset.bytes, format === 'json' ? 'application/json; charset=utf-8' : 'image/svg+xml', expiry, asset.etag, false);
});

const tileParamSchema = z.object({ model: param, buildId: param, layer: param, frame: param, z: param, x: param, y: param });
app.openAPIRegistry.registerPath(
  createRoute({
    method: 'get',
    path: '/tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp',
    request: { params: tileParamSchema, query: z.object({}) },
    responses: {
      200: { description: 'Rendered lossless WebP tile', content: { 'image/webp': { schema: z.string().openapi({ type: 'string', format: 'binary' }) } } },
      ...problemResponses
    }
  })
);
app.get('/tiles/:model/:buildId/:layer/:frame/:z/:x/:filename', async c => {
  const url = new URL(c.req.url);
  query(url, []);
  const match = /^([0-9]+)\.webp$/.exec(c.req.param('filename'));
  if (!match) fail(400, 'invalid-tile', 'Invalid tile filename');
  const p = { ...c.req.param(), y: match[1] };
  if (!tileParamSchema.safeParse(p).success) fail(400, 'invalid-parameter', 'Invalid request parameters');
  const m = await pinnedManifest(c);
  const layer = layerId(p.layer);
  const a = artifact(m, layer, p.frame);
  if (![p.z, p.x, p.y].every(v => /^(0|[1-9][0-9]*)$/.test(v))) fail(400, 'invalid-tile', 'Invalid tile coordinates');
  const z = Number(p.z),
    x = Number(p.x),
    y = Number(p.y);
  const surface = m.surfaces.find(item => item.layers.includes(layer))!;
  if (!Number.isSafeInteger(z) || z > surface.coverage.maxZoom || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x >= 2 ** z || y >= 2 ** z) {
    fail(400, 'invalid-tile', 'Tile address out of range');
  }
  return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => {
    const signal = c.req.raw.signal;
    const { tiles } = await resolveSparseTiles(c.env.BUCKET, surface, m.descriptors.bounds, c.executionCtx, signal);
    const tileMask = { tiles, maxZoom: surface.coverage.maxZoom };
    const data = isTileCovered(tileMask, z, x, y) ? await readTile(c.env.BUCKET, a.tilesKey, z, x, y, c.executionCtx, signal) : blank;
    return response(data, 'image/webp', m.expiresAt, `${a.tilesSha256}-${z}-${x}-${y}`);
  });
});

app.openAPIRegistry.registerPath({ method: 'get', path: '/openapi.json', responses: { 200: { description: 'OpenAPI 3.1 document' } } });
app.openAPIRegistry.registerPath({ method: 'get', path: '/docs', responses: { 200: { description: 'Interactive API documentation' } } });
let openApi: Uint8Array | undefined;
app.get('/openapi.json', () => {
  openApi ??= new TextEncoder().encode(JSON.stringify(app.getOpenAPIDocument({
    openapi: '3.1.0', info: { title: 'Aviation Forecast Layers API', version: '1.0.0' }
  })));
  return response(openApi, 'application/json; charset=utf-8');
});
app.get('/docs', apiDocs);
app.notFound(() => {
  throw new Problem(404, 'not-found', 'Route not found');
});
app.onError(handleError);

return {
  async fetch(request: Request, env: Env['Bindings'], ctx: WaitContext): Promise<Response> {
    const start = performance.now();
    const metrics: RequestMetrics = { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 };
    const complete = (result: Response) => {
      const finished = performance.now(), elapsed = finished - start;
      const r2WaitMs = r2WaitDuration(metrics, finished);
      result.headers.set('x-av-response-cache', metrics.responseCache ?? 'not-applicable');
      const timing = [`worker;dur=${elapsed.toFixed(2)}`];
      if (metrics.admitMs !== undefined) timing.push(`admit;dur=${metrics.admitMs.toFixed(2)}`);
      if (r2WaitMs !== undefined) timing.push(`r2;dur=${r2WaitMs.toFixed(2)}`);
      result.headers.set('server-timing', timing.join(', '));
      for (const [name, value] of Object.entries({ 'r2-reads': metrics.r2Reads, 'r2-bytes': metrics.r2Bytes, 'cache-hits': metrics.cacheHits, coalesced: metrics.coalesced })) {
        result.headers.set(`x-av-${name}`, String(value));
      }
      const aborted = request.signal.aborted;
      if (env.AV_REQUEST_METRICS === 'true' || (!aborted && result.status >= 500)) {
        const method = ['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'other';
        console.log(JSON.stringify({ event: 'api-request', deploymentId: env.AV_DEPLOYMENT_ID, method,
          status: result.status, elapsedMs: Math.round(elapsed * 100) / 100, route: 'unmatched', responseCache: 'not-applicable', ...metrics, r2WaitMs,
          ...(aborted ? { aborted: true } : {}) }));
      }
      return result;
    };
    const reject = (status: number, code: string, detail: string, extra?: Record<string, string>) => {
      metrics.problemCode = code;
      return finish(request, new Response(
        JSON.stringify({ type: `urn:windy-av:${code}`, title: code, status, detail }),
        { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', ...extra } }
      ));
    };
    if (request.method === 'OPTIONS') {
      return complete(new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, HEAD, OPTIONS',
          'access-control-allow-headers': 'If-None-Match',
          'access-control-max-age': '86400'
        }
      }));
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return complete(reject(405, 'method-not-allowed', 'Only GET and HEAD are supported', { allow: 'GET, HEAD, OPTIONS' }));
    }
    const url = new URL(request.url);
    if (request.url.length > 16 * 1024 || url.pathname.includes('%')) {
      return complete(reject(400, 'invalid-parameter', 'Request URL exceeds its budget or uses noncanonical path encoding'));
    }
    if (['/docs', '/openapi.json'].includes(url.pathname) && url.search) {
      metrics.route = url.pathname;
      return complete(reject(400, 'invalid-query', 'Unknown query parameter'));
    }
    const req = request.method === 'HEAD' ? new Request(request, { method: 'GET' }) : request;
    const observed = { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise), metrics, responseCacheEnabled: env.AV_RESPONSE_CACHE !== 'off' };
    let result: Response;
    try { result = boundResponse(finish(request, await app.fetch(req, env, observed as unknown as Parameters<typeof app.fetch>[2]))); }
    catch (error) {
      const canceled = canceledRequest(request, error);
      if (canceled) result = finish(request, canceled);
      else if (error instanceof ResourceLimitError) result = reject(503, 'resource-limit', 'Serving resource budget exceeded');
      else {
        console.error('Worker response failed', error);
        result = reject(500, 'internal-error', 'Internal server error');
      }
    }
    return complete(result);
  }
};

}
export default createApp();
