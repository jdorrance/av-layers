import { addAbortSignal, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const R2_BODY_TIMEOUT_MS = 30_000;
const R2_MAX_ATTEMPTS = 3;

/** SDK retries stop at response headers; a fresh GET must replace an interrupted body. */
function retryableBodyError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError'
    || ['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException).code ?? ''));
}

function retryableRequestError(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 10) return false;
  const value = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number }; $retryable?: unknown; cause?: unknown };
  const status = value.$metadata?.httpStatusCode;
  if (value.name === 'AbortError' || status === 403 || status === 404) return false;
  return status === 429 || [500, 502, 503, 504].includes(status ?? 0) || value.$retryable !== undefined
    || ['TimeoutError', 'RequestTimeout', 'RequestTimeoutException', 'SlowDown', 'Throttling', 'ThrottlingException', 'TooManyRequestsException'].includes(value.name ?? '')
    || ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN'].includes(value.code ?? '')
    || retryableRequestError(value.cause, depth + 1);
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
  const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error('CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  return {
    region: 'auto',
    maxAttempts: R2_MAX_ATTEMPTS,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 30_000, socketTimeout: 30_000 },
    endpoint: `https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
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
            await delay(250 * (attempt + 1), undefined, { signal });
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
            await delay(250 * (attempt + 1), undefined, { signal });
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
