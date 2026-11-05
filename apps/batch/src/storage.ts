import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { addAbortSignal, Readable } from 'node:stream';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { BUILD_BUDGETS } from './capacity.js';
import type { BuildPlan } from './parallel.js';
import { pause } from './pause.js';

const R2_BODY_TIMEOUT_MS = 30_000;
const R2_MAX_ATTEMPTS = 3;
const MAX_SHARD_TTL_SECONDS = 3600;

/** SDK retries stop at response headers; a fresh GET must replace an interrupted body. */
function retryableBodyError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError'
    || ['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException).code ?? ''));
}

function retryableRequestError(error: unknown, depth = 0, includeBody = false): boolean {
  if (!error || typeof error !== 'object' || depth > 10) return false;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown; cause?: unknown };
  const status = value.$metadata?.httpStatusCode;
  if (status === 403 || status === 404) return false;
  if (value.name === 'AbortError') return includeBody && retryableRequestError(value.cause, depth + 1, includeBody);
  return (includeBody && retryableBodyError(error)) || status === 429 || [500, 502, 503, 504].includes(status ?? 0) || value.$retryable !== undefined
    || ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'SlowDown', 'Throttling', 'ThrottlingException', 'TooManyRequestsException'].includes(value.name ?? '')
    || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(value.code ?? '')
    || retryableRequestError(value.cause, depth + 1, includeBody);
}

/** Classify exhausted transport failures for checkpointed preparation retries. */
export function isTransientStorageError(error: unknown): boolean {
  return retryableRequestError(error, 0, true);
}

async function readBody(body: Readable, maximum: number, key: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (signal) addAbortSignal(signal, body);
  const timer = setTimeout(() => body.destroy(Object.assign(new Error('R2 response body timed out'), { name: 'TimeoutError' })), R2_BODY_TIMEOUT_MS);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      signal?.throwIfAborted();
      length += chunk.byteLength;
      if (length > maximum) throw new Error(`Object exceeds read byte budget: ${key}`);
      chunks.push(chunk);
    }
    signal?.throwIfAborted();
    return Buffer.concat(chunks, length);
  } catch (error) {
    body.destroy();
    throw error;
  } finally { clearTimeout(timer); }
}

export interface ObjectStorage {
  get(key: string, range?: { offset: number; length: number }, maxBytes?: number, signal?: AbortSignal, onRetry?: () => void): Promise<{ bytes: Uint8Array; etag: string } | null>;
  head(key: string, signal?: AbortSignal): Promise<{ size: number; etag: string; metadata?: Record<string, string>; computedSha256?: string } | null>;
  put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, contentType?: string, contentMd5?: string, metadata?: Record<string, string>): Promise<void>;
  list(prefix: string, signal?: AbortSignal): Promise<Array<{ key: string; lastModified: Date; size?: number }>>;
  delete(keys: string[], signal?: AbortSignal): Promise<void>;
}

export function r2ClientOptions(env: NodeJS.ProcessEnv = process.env): NonNullable<ConstructorParameters<typeof S3Client>[0]> {
  const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_SESSION_TOKEN } = env;
  if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error('CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  return {
    region: 'auto',
    maxAttempts: R2_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, socketTimeout: 30_000 },
    endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY, ...(R2_SESSION_TOKEN ? { sessionToken: R2_SESSION_TOKEN } : {}) },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  };
}

type ShardPlan = Pick<BuildPlan, 'model' | 'buildId' | 'createdAt' | 'deadlineAt'>;
type ShardCredential = { accessKeyId: string; secretAccessKey: string; sessionToken: string };
type ShardCredentials = { read: ShardCredential; write: ShardCredential };

export async function assertBuildBucketLock(env: NodeJS.ProcessEnv, plan: ShardPlan, fetchImpl: typeof fetch = fetch): Promise<void> {
  const { CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: token, R2_BUCKET: bucket } = env;
  if (!account || !token || !bucket) throw new Error('R2 bucket lock account, bucket and API token are required');
  const deadline = shardDeadline(plan);
  const signal = AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now())));
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/r2/buckets/${encodeURIComponent(bucket)}/lock`, {
    headers: { authorization: `Bearer ${token}` }, signal
  });
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error(`R2 bucket lock request failed: ${response.status}`); }
  const maximum = 256 * 1024, declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) {
    void response.body?.cancel().catch(() => {}); throw new Error('R2 bucket lock response exceeds byte budget');
  }
  if (!response.body) throw new Error('R2 bucket lock response body missing');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new Error('R2 bucket lock response exceeds byte budget');
      chunks.push(part.value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks, length).toString('utf8')) as { success?: unknown; result?: { rules?: unknown } };
  const prefix = `builds/${plan.model}/${plan.buildId}/`;
  const rules = body?.result?.rules;
  const protectedBuild = body?.success === true && Array.isArray(rules) && rules.some((rule: unknown) => {
    if (!rule || typeof rule !== 'object') return false;
    const value = rule as { enabled?: unknown; prefix?: unknown; condition?: { type?: unknown; maxAgeSeconds?: unknown; date?: unknown } };
    const rulePrefix = value.prefix === undefined ? '' : value.prefix;
    if (value.enabled !== true || typeof rulePrefix !== 'string' || !prefix.startsWith(rulePrefix) || !value.condition || typeof value.condition !== 'object') return false;
    const condition = value.condition;
    return condition.type === 'Indefinite'
      || (condition.type === 'Age' && typeof condition.maxAgeSeconds === 'number' && Number.isFinite(condition.maxAgeSeconds) && condition.maxAgeSeconds >= MAX_SHARD_TTL_SECONDS)
      || (condition.type === 'Date' && typeof condition.date === 'string' && Date.parse(condition.date) >= deadline);
  });
  signal.throwIfAborted();
  if (Date.now() >= deadline || !protectedBuild) throw new Error('R2 bucket lock does not protect the build through shard credential expiry');
}

function shardDeadline(plan: ShardPlan): number {
  if (!/^[a-z0-9-]+$/.test(plan.model) || !/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(plan.buildId)) throw new Error('Invalid shard build identity');
  const deadline = plan.deadlineAt === undefined ? Date.parse(plan.createdAt) + BUILD_BUDGETS.elapsedMs : Date.parse(plan.deadlineAt);
  if (!Number.isFinite(deadline) || Math.floor(deadline / 1000) <= Math.floor(Date.now() / 1000)) throw new Error('Forecast plan deadline expired or invalid');
  return deadline;
}

function shardContext(env: NodeJS.ProcessEnv, plan: ShardPlan): { bucket: string; key: Buffer; aad: Buffer; deadline: number } {
  const bucket = env.R2_BUCKET, hex = env.FORECAST_SHARD_CREDENTIAL_KEY;
  if (!bucket) throw new Error('R2_BUCKET is required');
  if (!hex || !/^[a-f0-9]{64}$/i.test(hex)) throw new Error('FORECAST_SHARD_CREDENTIAL_KEY must be 32 bytes encoded as hex');
  const deadline = shardDeadline(plan);
  const deadlineAt = plan.deadlineAt ?? new Date(deadline).toISOString();
  return { bucket, key: Buffer.from(hex, 'hex'), aad: Buffer.from(JSON.stringify([bucket, plan.model, plan.buildId, deadlineAt])), deadline };
}

export function sealShardCredentials(env: NodeJS.ProcessEnv, plan: ShardPlan): string {
  const { CLOUDFLARE_ACCOUNT_ID: account, R2_BUCKET: bucket, R2_ACCESS_KEY_ID: access, R2_SECRET_ACCESS_KEY: secret } = env;
  if (!account || !bucket || !access || !secret) throw new Error('R2 shard account, bucket and parent credentials are required');
  const context = shardContext(env, plan);
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + MAX_SHARD_TTL_SECONDS, Math.floor(context.deadline / 1000));
  const prefix = `builds/${plan.model}/${plan.buildId}/`;
  const scoped = (actions: string[], prefixPaths: string[]): ShardCredential => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const payload = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ bucket, actions,
      paths: { prefixPaths, objectPaths: [] }, sub: account, iss: access, aud: `${account}.r2.cloudflarestorage.com`, iat: now, exp })}`;
    const jwt = `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
    return { accessKeyId: access, secretAccessKey: createHash('sha256').update(jwt).digest('hex'), sessionToken: Buffer.from(`jwt/${jwt}`).toString('base64') };
  };
  const credentials: ShardCredentials = { read: scoped(['GetObject', 'HeadObject'], [prefix, 'coverage/', 'terrain/prepared/']), write: scoped(['PutObject'], [prefix]) };
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', context.key, iv);
  cipher.setAAD(context.aad);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  const envelope = JSON.stringify({ iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
  if (Buffer.byteLength(envelope) > 16 * 1024) throw new Error('Shard credential envelope exceeds byte budget');
  return envelope;
}

export function r2ShardStorage(env: NodeJS.ProcessEnv, plan: ShardPlan, envelope: Uint8Array): ObjectStorage {
  const context = shardContext(env, plan), account = env.CLOUDFLARE_ACCOUNT_ID;
  if (!account) throw new Error('CLOUDFLARE_ACCOUNT_ID is required');
  if (envelope.byteLength > 16 * 1024) throw new Error('Shard credential envelope exceeds byte budget');
  let credentials: ShardCredentials;
  try {
    const parsed = JSON.parse(Buffer.from(envelope).toString('utf8')) as Record<string, unknown>;
    const decode = (value: unknown, bytes?: number): Buffer => {
      if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('Invalid encoding');
      const result = Buffer.from(value, 'base64');
      if (!result.length || (bytes !== undefined && result.length !== bytes)) throw new Error('Invalid length');
      return result;
    };
    const decipher = createDecipheriv('aes-256-gcm', context.key, decode(parsed.iv, 12));
    decipher.setAAD(context.aad); decipher.setAuthTag(decode(parsed.tag, 16));
    credentials = JSON.parse(Buffer.concat([decipher.update(decode(parsed.ciphertext)), decipher.final()]).toString('utf8')) as ShardCredentials;
    for (const credential of [credentials.read, credentials.write]) {
      if (!credential || typeof credential.accessKeyId !== 'string' || !credential.accessKeyId || typeof credential.secretAccessKey !== 'string' || !/^[a-f0-9]{64}$/.test(credential.secretAccessKey) || !/^jwt\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(decode(credential.sessionToken).toString('utf8'))) throw new Error('Invalid credential');
    }
  } catch { throw new Error('Invalid or unauthenticated shard credential envelope'); }
  const store = (credential: ShardCredential) => r2Storage({ CLOUDFLARE_ACCOUNT_ID: account, R2_BUCKET: context.bucket,
    R2_ACCESS_KEY_ID: credential.accessKeyId, R2_SECRET_ACCESS_KEY: credential.secretAccessKey, R2_SESSION_TOKEN: credential.sessionToken });
  const readStore = store(credentials.read), writeStore = store(credentials.write);
  return {
    get: (...args) => readStore.get(...args), head: (...args) => readStore.head(...args),
    put: (...args) => writeStore.put(...args),
    async list() { throw new Error('Shard storage cannot list objects'); },
    async delete() { throw new Error('Shard storage cannot delete objects'); }
  };
}

export function r2Storage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const { R2_BUCKET } = env;
  if (!R2_BUCKET) throw new Error('R2_BUCKET is required');
  const client = new S3Client(r2ClientOptions(env));
  let boundedClient: S3Client | undefined;
  return {
    async get(key, range, maxBytes = 256 * 1024 * 1024, signal, onRetry) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid read budget');
      try {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted();
          if (attempt) onRetry?.();
          const requestClient = onRetry ? (boundedClient ??= new S3Client({ ...r2ClientOptions(env), maxAttempts: 1 })) : client;
          const maximum = Math.min(range?.length ?? maxBytes, maxBytes);
          const command = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined });
          if (onRetry) command.middlewareStack.add(next => async args => {
            const result = await next(args);
            const response = result.response as { statusCode?: number; headers?: Record<string, string>; body?: unknown };
            if ((response.statusCode ?? 0) >= 400) {
              const body = response.body, status = response.statusCode!;
              if ([403, 404, 429, 500, 502, 503, 504].includes(status)) {
                if (body instanceof Readable) body.destroy();
                throw Object.assign(new Error(`R2 returned HTTP ${status}`), { $metadata: { httpStatusCode: status } });
              }
              if (body instanceof Uint8Array && body.byteLength > maximum) throw new Error(`Object exceeds read byte budget: ${key}`);
              if (body !== undefined && !(body instanceof Uint8Array) && !(body instanceof Readable)) throw new Error(`Incomplete response for ${key}`);
              if (!(body instanceof Readable)) return result;
              const declared = Number(Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === 'content-length')?.[1]);
              if (Number.isFinite(declared) && declared > maximum) { body.destroy(); throw new Error(`Object exceeds read byte budget: ${key}`); }
              response.body = Readable.from((async function* () {
                const timer = setTimeout(() => body.destroy(Object.assign(new Error('R2 response body timed out'), { name: 'TimeoutError' })), R2_BODY_TIMEOUT_MS);
                if (signal) addAbortSignal(signal, body);
                let bytes = 0;
                try {
                  for await (const chunk of body as AsyncIterable<Uint8Array>) {
                    signal?.throwIfAborted();
                    bytes += chunk.byteLength;
                    if (bytes > maximum) throw new Error(`Object exceeds read byte budget: ${key}`);
                    yield chunk;
                  }
                } finally { clearTimeout(timer); body.destroy(); }
              })());
            }
            return result;
          }, { step: 'deserialize', priority: 'low', name: 'boundedR2ErrorBody' });
          let result;
          try { result = await requestClient.send(command, { abortSignal: signal }); }
          catch (error) {
            signal?.throwIfAborted();
            if (!onRetry || attempt >= R2_MAX_ATTEMPTS - 1 || !retryableRequestError(error)) throw error;
            await pause(250 * (attempt + 1), signal);
            continue;
          }
          if (!(result.Body instanceof Readable) || !result.ETag) {
            if (result.Body instanceof Readable) result.Body.destroy();
            throw new Error(`Incomplete response for ${key}`);
          }
          if (result.ContentLength === undefined || result.ContentLength > maximum) {
            result.Body.destroy();
            throw new Error(`Object exceeds read byte budget: ${key}`);
          }
          let bytes: Uint8Array;
          try { bytes = await readBody(result.Body, maximum, key, signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (attempt >= R2_MAX_ATTEMPTS - 1 || !retryableBodyError(error)) throw error;
            await pause(250 * (attempt + 1), signal);
            continue;
          }
          if (bytes.length !== result.ContentLength) throw new Error(`Incorrect object response length for ${key}`);
          if (range && bytes.length !== range.length) throw new Error(`Incorrect range length for ${key}`);
          return { bytes, etag: result.ETag };
        }
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode === 404) return null;
        const code = (error as NodeJS.ErrnoException)?.code;
        throw new Error(`R2 GET ${key}${range ? ` (bytes ${range.offset}–${range.offset + range.length - 1})` : ''}: ${error instanceof Error ? error.message : String(error)}${code ? ` [${code}]` : ''}`, { cause: error });
      }
    },
    async head(key, signal) {
      signal?.throwIfAborted();
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }), { abortSignal: signal });
        if (result.ContentLength === undefined || !result.ETag) throw new Error(`Incomplete response for ${key}`);
        return { size: result.ContentLength, etag: result.ETag, ...(result.Metadata ? { metadata: result.Metadata } : {}) };
      } catch (error) {
        signal?.throwIfAborted();
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async put(key, bytes, condition, contentType, contentMd5, metadata) {
      await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, IfMatch: condition.ifMatch, IfNoneMatch: condition.ifNoneMatch, ContentType: contentType, ContentMD5: contentMd5, Metadata: metadata }));
    },
    async list(prefix, signal) {
      const objects: Array<{ key: string; lastModified: Date; size?: number }> = [];
      let token: string | undefined;
      const seen = new Set<string>();
      let pages = 0;
      do {
        signal?.throwIfAborted();
        if (++pages > 1000) throw new Error('Object listing exceeds page budget');
        const page = await client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token }), { abortSignal: signal });
        signal?.throwIfAborted();
        if (objects.length + (page.Contents?.length ?? 0) > 100_000) throw new Error('Object listing exceeds maintenance budget');
        for (const object of page.Contents ?? []) {
          if (!object.Key || !object.LastModified) throw new Error('Incomplete object listing');
          if (object.Size !== undefined && (!Number.isSafeInteger(object.Size) || object.Size < 0)) throw new Error('Invalid object listing size');
          objects.push({ key: object.Key, lastModified: object.LastModified, ...(object.Size === undefined ? {} : { size: object.Size }) });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && (!token || seen.has(token))) throw new Error('Invalid or repeated listing continuation token');
        if (token) seen.add(token);
      } while (token);
      return objects;
    },
    async delete(keys, signal) {
      for (let i = 0; i < keys.length; i += 1000) {
        signal?.throwIfAborted();
        const result = await client.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true } }), { abortSignal: signal });
        if (result.Errors?.length) throw new Error(`Object deletion failed: ${JSON.stringify(result.Errors)}`);
      }
    }
  };
}
