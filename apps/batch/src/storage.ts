import { DeleteObjectsCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';

export interface ObjectStorage {
  get(key: string, range?: { offset: number; length: number }): Promise<{ bytes: Uint8Array; etag: string } | null>;
  head(key: string): Promise<{ size: number; etag: string } | null>;
  put(key: string, bytes: Uint8Array, condition: { ifMatch?: string; ifNoneMatch?: '*' }, contentType?: string, contentMd5?: string): Promise<void>;
  list(prefix: string): Promise<Array<{ key: string; lastModified: Date }>>;
  delete(keys: string[]): Promise<void>;
}

export function r2Storage(env: NodeJS.ProcessEnv = process.env): ObjectStorage {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = env;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET are required');
  const client = new S3Client({ region: 'auto', endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY } });
  return {
    async get(key, range) {
      try {
        const result = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key, Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined }));
        if (!result.Body || !result.ETag) throw new Error(`Incomplete response for ${key}`);
        const bytes = await result.Body.transformToByteArray();
        if (range && bytes.length !== range.length) throw new Error(`Incorrect range length for ${key}`);
        return { bytes, etag: result.ETag };
      } catch (error) {
        if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    },
    async head(key) {
      try {
        const result = await client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
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
    async list(prefix) {
      const objects: Array<{ key: string; lastModified: Date }> = [];
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token }));
        for (const object of page.Contents ?? []) {
          if (!object.Key || !object.LastModified) throw new Error('Incomplete object listing');
          objects.push({ key: object.Key, lastModified: object.LastModified });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
        if (page.IsTruncated && !token) throw new Error('Truncated listing without continuation token');
      } while (token);
      return objects;
    },
    async delete(keys) {
      for (let i = 0; i < keys.length; i += 1000) {
        const result = await client.send(new DeleteObjectsCommand({ Bucket: R2_BUCKET, Delete: { Objects: keys.slice(i, i + 1000).map(Key => ({ Key })), Quiet: true } }));
        if (result.Errors?.length) throw new Error(`Object deletion failed: ${JSON.stringify(result.Errors)}`);
      }
    }
  };
}
