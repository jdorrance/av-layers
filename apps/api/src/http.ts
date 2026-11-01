import type { Context } from 'hono';
import { CoverageError } from './coverage';
import { countCacheHit, reserveAllocation, boundResponse, createBoundedResponse, forkResponseForCache, estimateJsonBytes, ResourceLimitError, type WaitContext } from './resources';

const IMMUTABLE_TTL = 86400;

export class Problem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    detail: string
  ) {
    super(detail);
  }
}

export function fail(status: number, code: string, detail: string): never {
  throw new Problem(status, code, detail);
}

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export function validateId(value: string): string {
  if (!idPattern.test(value)) fail(400, 'invalid-parameter', 'Invalid resource identifier');
  return value;
}

function ttl(expiresAt: string): number {
  return Math.max(0, Math.min(IMMUTABLE_TTL, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)));
}

export function ensureLive(expiresAt: string): void {
  if (!Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
    fail(404, 'not-retained', 'Build is expired or not retained');
  }
}

export function query(url: URL, allowed: string[]): void {
  const seen = new Set<string>();
  for (const key of url.searchParams.keys()) {
    if (!allowed.includes(key) || seen.has(key)) fail(400, 'invalid-query', 'Unknown or duplicate query parameter');
    seen.add(key);
  }
}

export function response(body: BodyInit | null, type: string, expiresAt?: string, etag?: string): Response {
  if (expiresAt) ensureLive(expiresAt);
  const headers = new Headers({
    'content-type': type,
    'cache-control': expiresAt ? `public, max-age=${ttl(expiresAt)}` : 'no-store'
  });
  let size = body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? body.byteLength : 1024 * 1024;
  if (typeof body === 'string') {
    size = 0;
    for (const character of body) { const code = character.codePointAt(0)!; size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
  }
  if (etag) headers.set('etag', `"${etag}"`);
  return createBoundedResponse(size, () => {
    const payload = typeof body === 'string' ? new TextEncoder().encode(body) : body;
    if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) headers.set('content-length', String(payload.byteLength));
    return new Response(payload, { headers });
  });
}

export function json(value: unknown, expiresAt?: string, etag?: string): Response {
  const release = reserveAllocation(Math.max(1024, estimateJsonBytes(value) * 2));
  try { return response(JSON.stringify(value), 'application/json; charset=utf-8', expiresAt, etag); }
  finally { release(); }
}

export function finish(request: Request, res: Response, expiresAt?: string): Response {
  if (expiresAt) ensureLive(expiresAt);
  const headers = new Headers(res.headers);
  if (expiresAt) headers.set('cache-control', `public, max-age=${ttl(expiresAt)}`);
  headers.set('access-control-allow-origin', '*');
  headers.set('access-control-expose-headers', 'ETag, Cache-Control, Server-Timing, X-Av-R2-Reads, X-Av-R2-Bytes, X-Av-Cache-Hits, X-Av-Coalesced, X-Av-Response-Cache');
  if (
    res.status === 200 &&
    headers.has('etag') &&
    request.headers
      .get('if-none-match')
      ?.split(',')
      .map(x => x.trim())
      .includes(headers.get('etag')!)
  ) {
    void res.body?.cancel().catch(() => {});
    return new Response(null, { status: 304, headers });
  }
  if (request.method === 'HEAD') void res.body?.cancel().catch(() => {});
  return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers });
}

export async function cached(request: Request, expiresAt: string, ctx: WaitContext, build: () => Promise<Response>, representation?: string): Promise<Response> {
  ensureLive(expiresAt);
  if (ctx.responseCacheEnabled === false) {
    if (ctx.metrics) ctx.metrics.responseCache = 'bypass';
    return finish(request, await build(), expiresAt);
  }
  const cache = typeof caches !== 'undefined' ? (caches as CacheStorage & { default?: Cache }).default : undefined;
  const cacheUrl = new URL(request.url);
  if (representation) cacheUrl.searchParams.set('__representation', representation);
  const key = new Request(cacheUrl, { method: 'GET' });
  const hit = await cache?.match(key);
  if (ctx.metrics) ctx.metrics.responseCache = hit ? 'hit' : 'miss';
  if (hit) { countCacheHit(ctx); return finish(request, boundResponse(hit), expiresAt); }
  let result = await build();
  ensureLive(expiresAt);
  if (cache && result.status === 200 && ttl(expiresAt) > 0) {
    const branches = forkResponseForCache(result);
    result = branches.client;
    ctx.waitUntil(cache.put(key, branches.cache).finally(() => { void branches.cache.body?.cancel().catch(() => {}); }));
  }
  return finish(request, result, expiresAt);
}

export function validIp(ip: string): boolean {
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

export function handleError(error: Error, c: Context): Response {
  if (!(error instanceof Problem) && !(error instanceof CoverageError) && !(error instanceof ResourceLimitError)) {
    console.error('Unhandled API error', {
      method: c.req.method,
      path: c.req.path,
      params: c.req.param(),
      error: error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error)
    });
  }
  const problem = error instanceof Problem ? error : error instanceof CoverageError ? new Problem(503, 'coverage-unavailable', error.message) : error instanceof ResourceLimitError ? new Problem(503, 'resource-limit', 'Serving resource budget exceeded') : new Problem(503, 'publication-unavailable', 'Publication or archive unavailable');
  const result = response(JSON.stringify({ type: `urn:windy-av:${problem.code}`, title: problem.code, status: problem.status, detail: problem.message }), 'application/problem+json; charset=utf-8');
  return new Response(result.body, { status: problem.status, headers: result.headers });
}
