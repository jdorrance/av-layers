import { addAbortSignal, Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

const R2_BODY_TIMEOUT_MS = 30_000;

/** SDK retries stop at response headers; a fresh GET must replace an interrupted body. */
function retryableBodyError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError'
    || ['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'].includes((error as NodeJS.ErrnoException).code ?? ''));
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
  get(key: string, range?: { offset: number; length: number }, maxBytes?: number, signal?: AbortSignal): Promise<{ bytes: Uint8Array; etag: string } | null>;
  head(key: string, signal?: AbortSignal): Promise<{ size: number; etag: string } | null>;
  put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, contentType?: string, contentMd5?: string): Promise<void>;
  list(prefix: string, signal?: AbortSignal): Promise<Array<{ key: string; lastModified: Date; size?: number }>>;
  delete(keys: string[], signal?: AbortSignal): Promise<void>;
}

export function r2ClientOptions(env: NodeJS.ProcessEnv = process.env): NonNullable<ConstructorParameters<typeof S3Client>[0]> {
  const { CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = env;
  if (!CLOUDFLARE_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) throw new Error('CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are required');
  return {
    region: 'auto',
    maxAttempts: 3,
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
  return {
    async get(key, range, maxBytes = 256 * 1024 * 1024, signal) {
      signal?.throwIfAborted();
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid read budget');
      try {
        for (let attempt = 0; ; attempt++) {
          signal?.throwIfAborted();
          const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined }), { abortSignal: signal });
          if (!(result.Body instanceof Readable) || !result.ETag) {
            if (result.Body instanceof Readable) result.Body.destroy();
            throw new Error(`Incomplete response for ${key}`);
          }
          const maximum = Math.min(range?.length ?? maxBytes, maxBytes);
          if (result.ContentLength === undefined || result.ContentLength > maximum) {
            result.Body.destroy();
            throw new Error(`Object exceeds read byte budget: ${key}`);
          }
          let bytes: Uint8Array;
          try { bytes = await readBody(result.Body, maximum, key, signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (attempt >= 2 || !retryableBodyError(error)) throw error;
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
        return { size: result.ContentLength, etag: result.ETag };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async put(key, bytes, condition, contentType, contentMd5) {
      await client.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: bytes, IfMatch: condition.ifMatch, IfNoneMatch: condition.ifNoneMatch, ContentType: contentType, ContentMD5: contentMd5 }));
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
