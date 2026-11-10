import { OpenAPIHono, createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import type { Context, MiddlewareHandler } from 'hono';
import {
  PRODUCTS,
  type ProductDefinition,
  LAYER_IDS,
  PALETTES,
  computeFreshness,
  freshnessSchema,
  isPaletteId,
  isTileCovered,
  latestSchema,
  manifestSchema,
  publishedManifestSchema,
  modelPointerSchema,
  paletteSchema,
  provenanceSchema,
  frameProvenanceSchema,
  sampleResponseSchema,
  sampleResponseV5Schema,
  multiPointSampleResponseSchema,
  profileResponseSchema,
  renderedLayers,
  type LayerId,
  type ModelId,
  type ModelPointer
} from '@av/contracts';
import { serveSample, serveSamples } from './sample';
import { serveProfile } from './profile';
import { readTile } from './pmtiles';
import { paletteSvg } from './palette-svg';
import { resolveCoverage, resolveSparseTiles, sha256 } from './coverage';
import { type RequestMetrics, boundResponse, ResourceLimitError, waitFor, type WaitContext } from './resources';
import { pointer, pointerCacheState, admit, manifest, provenanceReference, servedSource, artifact, readProvenance, readProvenanceFrame } from './publication';
import { Problem, fail, query, response, json, finish, cached, validIp, handleError } from './http';
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
  const representation = `discovery-v1:${config}:${states.map(state => state?.identity ?? 'uncached').join(':')}`;
  return cached(c.req.raw, expiresAt, c.executionCtx, async () => json(build()), representation, until);
}
const modelId = (value: string): ModelId => {
  if (!Object.hasOwn(products, value)) fail(404, 'unknown-model', 'Unknown model');
  return value;
};
const app = new OpenAPIHono<Env>({
  defaultHook: result => {
    if (!result.success) fail(400, 'invalid-parameter', 'Invalid request parameters');
  }
});

const pointRateLimit: MiddlewareHandler<Env> = async (c, next) => {
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
const manifestResponseSchema = publishedManifestSchema.meta({ id: 'PublishedManifest' });

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

const catalogModelSchema = z.object({
  model: z.string(),
  label: z.string().optional(),
  available: z.boolean(),
  latest: z.string().optional(),
  cycle: z.string().optional(),
  expiresAt: z.string().optional(),
  coverage: manifestSchema.shape.coverage.optional(),
  surfaces: sampleResponseV5Schema.shape.surfaces.optional(),
  ageSeconds: z.number().optional(),
  freshness: freshnessSchema.optional(),
  error: z.string().optional()
});

function unavailableCatalogModel(model: string, label: string, error: string) {
  return { model, label, available: false, error };
}

registerJsonRoute(
  '/v1/catalog',
  {},
  {},
  z.object({ models: z.array(catalogModelSchema) }),
  async c => {
    const results = await Promise.all(
      Object.entries(products).map(async ([model, product]): Promise<{ row: z.infer<typeof catalogModelSchema>; observed: ModelPointer | Problem }> => {
        try {
          const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx);
          const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId, c.executionCtx, ptr);
          const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry, c.executionCtx, product);
          const freshness = computeFreshness(m);
          return { observed: ptr, row: {
            model,
            label: product.label,
            available: true,
            latest: `/v1/models/${model}/latest`,
            cycle: m.cycle,
            expiresAt: m.expiresAt,
            ...(m.version === 5 ? { surfaces: m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })) } : { coverage: m.coverage }),
            ageSeconds: freshness.ageSeconds,
            freshness
          } };
        } catch (error) {
          if (error instanceof Problem && ['publication-unavailable', 'publication-invalid', 'publication-incomplete', 'not-retained'].includes(error.code)) {
            if (error.code === 'publication-invalid' || error.code === 'publication-incomplete') console.warn('Catalog publication unavailable', { model, code: error.code });
            return { observed: error, row: unavailableCatalogModel(model, product.label, error.code) };
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
        ? unavailableCatalogModel(row.model, products[row.model].label, 'not-retained') : row);
      return finish(c.req.raw, json({ models }));
    }
  }
);

registerJsonRoute(
  '/v1/models/{model}/latest',
  { model: param },
  { expand: z.enum(['manifest']).optional() },
  latestSchema.extend({ manifest: manifestResponseSchema.optional() }),
  async (c, url) => {
    const model = modelId(requiredParam(c, 'model'));
    const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx);
    const entry = await admit(c.env.BUCKET, model, ptr.latestBuildId, c.executionCtx, ptr);
    const m = await manifest(c.env.BUCKET, model, ptr.latestBuildId, entry, c.executionCtx, products[model]);
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
    const model = modelId(requiredParam(c, 'model'));
    const ptr = await pointer(c.env.BUCKET, model, false, c.executionCtx);
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
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const entry = await admit(c.env.BUCKET, model, buildId, c.executionCtx);
    const m = await manifest(c.env.BUCKET, model, buildId, entry, c.executionCtx, products[model]);
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
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const entry = await admit(c.env.BUCKET, model, buildId, c.executionCtx);
    const m = await manifest(c.env.BUCKET, model, buildId, entry, c.executionCtx, products[model]);
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
    const model = modelId(requiredParam(c, 'model'));
    const buildId = requiredParam(c, 'buildId');
    const layer = layerId(requiredParam(c, 'layer'));
    const frame = requiredParam(c, 'frame');
    const entry = await admit(c.env.BUCKET, model, buildId, c.executionCtx);
    const m = await manifest(c.env.BUCKET, model, buildId, entry, c.executionCtx, products[model]);
    artifact(m, layer, frame);
    return cached(c.req.raw, m.expiresAt, c.executionCtx, async () =>
      json(
        {
          tilejson: '3.0.0',
          name: `${layer} ${frame}`,
          tiles: [`${url.origin}/tiles/${model}/${m.buildId}/${layer}/${frame}/{z}/{x}/{y}.webp`],
          minzoom: 0,
          maxzoom: m.version === 5 ? m.surfaces.find(surface => surface.layers.includes(layer))!.coverage.maxZoom : m.coverage.maxZoom,
          bounds: m.descriptors.bounds
        },
        m.expiresAt,
        `tilejson-${m.buildId}-${layer}-${frame}`
      )
    );
  }
);

async function pointManifest(c: Context<Env>) {
  const model = modelId(requiredParam(c, 'model')), buildId = requiredParam(c, 'buildId');
  c.req.raw.signal.throwIfAborted();
  const entry = await waitFor(admit(c.env.BUCKET, model, buildId, c.executionCtx), c.req.raw.signal);
  c.req.raw.signal.throwIfAborted();
  return waitFor(manifest(c.env.BUCKET, model, buildId, entry, c.executionCtx, products[model]), c.req.raw.signal);
}

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/sample',
  { model: param, buildId: param },
  { lat: z.string(), lon: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  z.union([sampleResponseSchema, sampleResponseV5Schema]),
  async (c, url) => {
    const m = await pointManifest(c);
    return serveSample(c.req.raw, c.env.BUCKET, c.executionCtx, m, url);
  }
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/samples',
  { model: param, buildId: param },
  { points: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  multiPointSampleResponseSchema,
  async (c, url) => serveSamples(c.req.raw, c.env.BUCKET, c.executionCtx, await pointManifest(c), url)
);

registerJsonRoute(
  '/v1/models/{model}/runs/{buildId}/profile',
  { model: param, buildId: param },
  { lat: z.string(), lon: z.string(), frame: z.string().optional(), layers: z.string().optional() },
  profileResponseSchema,
  async (c, url) => serveProfile(c.req.raw, c.env.BUCKET, c.executionCtx, await pointManifest(c), url)
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
  const model = modelId(p.model);
  const entry = await admit(c.env.BUCKET, model, p.buildId, c.executionCtx);
  const m = await manifest(c.env.BUCKET, model, p.buildId, entry, c.executionCtx, products[model]);
  const layer = layerId(p.layer);
  const a = artifact(m, layer, p.frame);
  if (![p.z, p.x, p.y].every(v => /^(0|[1-9][0-9]*)$/.test(v))) fail(400, 'invalid-tile', 'Invalid tile coordinates');
  const z = Number(p.z),
    x = Number(p.x),
    y = Number(p.y);
  const surface = m.version === 5 ? m.surfaces.find(item => item.layers.includes(layer))! : undefined;
  if (!Number.isSafeInteger(z) || z > (surface?.coverage.maxZoom ?? (m.version === 5 ? 0 : m.coverage.maxZoom)) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x >= 2 ** z || y >= 2 ** z) {
    fail(400, 'invalid-tile', 'Tile address out of range');
  }
  return cached(c.req.raw, m.expiresAt, c.executionCtx, async () => {
    const tileMask = m.version === 5
      ? { tiles: (await resolveSparseTiles(c.env.BUCKET, surface!, m.descriptors.bounds, c.executionCtx)).tiles, maxZoom: surface!.coverage.maxZoom }
      : (await resolveCoverage(c.env.BUCKET, m, c.executionCtx)).mask;
    const data = isTileCovered(tileMask, z, x, y) ? await readTile(c.env.BUCKET, a.tilesKey, z, x, y, c.executionCtx) : blank;
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
    if (request.url.length > 16 * 1024 || url.pathname.includes('%')) {
      return finish(
        request,
        new Response(
          JSON.stringify({
            type: 'urn:windy-av:invalid-parameter',
            title: 'invalid-parameter',
            status: 400,
            detail: 'Request URL exceeds its budget or uses noncanonical path encoding'
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
    const start = performance.now();
    const metrics: RequestMetrics = { r2Reads: 0, r2Bytes: 0, cacheHits: 0, coalesced: 0 };
    const observed = { waitUntil: (promise: Promise<unknown>) => ctx.waitUntil(promise), metrics, responseCacheEnabled: env.AV_RESPONSE_CACHE !== 'off' };
    let result: Response;
    try { result = boundResponse(finish(request, await app.fetch(req, env, observed as unknown as Parameters<typeof app.fetch>[2]))); }
    catch (error) {
      const limited = error instanceof ResourceLimitError;
      if (!limited) console.error('Worker response failed', error);
      const title = limited ? 'resource-limit' : 'internal-error', status = limited ? 503 : 500;
      const detail = limited ? 'Serving resource budget exceeded' : 'Internal server error';
      result = finish(request, new Response(JSON.stringify({ type: `urn:windy-av:${title}`, title, status, detail }), { status, headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store' } }));
    }
    const elapsed = performance.now() - start;
    result.headers.set('x-av-response-cache', metrics.responseCache ?? 'not-applicable');
    result.headers.set('server-timing', `worker;dur=${elapsed.toFixed(2)}`);
    for (const [name, value] of Object.entries({ 'r2-reads': metrics.r2Reads, 'r2-bytes': metrics.r2Bytes, 'cache-hits': metrics.cacheHits, coalesced: metrics.coalesced })) result.headers.set(`x-av-${name}`, String(value));
    if (env.AV_REQUEST_METRICS === 'true') console.log(JSON.stringify({ event: 'api-request', deploymentId: env.AV_DEPLOYMENT_ID, route: url.pathname.startsWith('/tiles/') ? 'tile' : ['sample', 'samples', 'profile'].some(path => url.pathname.endsWith('/' + path)) ? 'sample' : 'metadata', status: result.status, elapsedMs: Math.round(elapsed * 100) / 100, ...metrics }));
    return result;
  }
};

}
export default createApp();
