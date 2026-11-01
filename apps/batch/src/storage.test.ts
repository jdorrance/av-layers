import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { r2ClientOptions, r2Storage } from './storage';

const env = { R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' };

describe('R2 S3 client configuration', () => {
  it('preserves listed object sizes and distinguishes missing metadata from zero bytes', async () => {
    const lastModified = new Date('2026-11-01T00:00:00Z');
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Contents: [
      { Key: 'a', LastModified: lastModified, Size: 42 }, { Key: 'b', LastModified: lastModified, Size: 0 }, { Key: 'c', LastModified: lastModified }
    ] } as never);
    try {
      expect(await r2Storage({ ...env, R2_BUCKET: 'test' }).list('')).toEqual([{ key: 'a', lastModified, size: 42 }, { key: 'b', lastModified, size: 0 }, { key: 'c', lastModified }]);
      send.mockResolvedValue({ Contents: [{ Key: 'a', LastModified: lastModified, Size: -1 }] } as never);
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).list('')).rejects.toThrow('Invalid object listing size');
    } finally { send.mockRestore(); }
  });

  it('bounds empty truncated pages even when every continuation token is new', async () => {
    let pages = 0;
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => ({ Contents: [], IsTruncated: true, NextContinuationToken: `page-${++pages}` }) as never);
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).list('builds/gfs/')).rejects.toThrow('page budget');
      expect(pages).toBe(1000);
    } finally { send.mockRestore(); }
  });

  it.each(['list', 'delete'] as const)('stops %s between provider batches when cancelled', async operation => {
    const controller = new AbortController();
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => { controller.abort(new Error('cancel maintenance')); return { Contents: [], IsTruncated: true, NextContinuationToken: 'next' } as never; });
    try {
      const store = r2Storage({ ...env, R2_BUCKET: 'test' });
      const pending = operation === 'list' ? store.list('builds/gfs/', controller.signal) : store.delete(Array.from({ length: 1001 }, (_, i) => `key-${i}`), controller.signal);
      await expect(pending).rejects.toThrow('cancel maintenance');
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0][1]).toEqual({ abortSignal: controller.signal });
    } finally { send.mockRestore(); }
  });

  it('rejects a truncated object stream even when no Range was requested', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 4, ETag: 'etag', Body: Readable.from([Uint8Array.of(1, 2)]) } as never);
    try { await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('manifest')).rejects.toThrow('response length'); }
    finally { send.mockRestore(); }
  });

  it('uses the R2 endpoint and required-only SDK checksums', () => {
    const options = r2ClientOptions(env)!;
    expect(options.endpoint).toBe(`https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(options.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(options.responseChecksumValidation).toBe('WHEN_REQUIRED');
  });

  it('sends only Content-MD5 on PUT while preserving the required DeleteObjects checksum', async () => {
    const requests: Array<{ method: string; checksums: Record<string, string> }> = [];
    const client = new S3Client({
      ...r2ClientOptions(env),
      requestHandler: {
        async handle(request: { method: string; headers: Record<string, string> }) {
          requests.push({
            method: request.method,
            checksums: Object.fromEntries(Object.entries(request.headers).filter(([name]) => /checksum|content-md5|trailer/i.test(name)))
          });
          return { response: { statusCode: 200, headers: {}, body: Buffer.from(request.method === 'POST' ? '<DeleteResult />' : '') } };
        }
      }
    });
    const bytes = Buffer.from('forecast payload');
    const contentMd5 = createHash('md5').update(bytes).digest('base64');
    try {
      await client.send(new PutObjectCommand({ Bucket: 'test-bucket', Key: 'forecast.bin', Body: bytes, ContentMD5: contentMd5 }));
      await client.send(new DeleteObjectsCommand({ Bucket: 'test-bucket', Delete: { Objects: [{ Key: 'forecast.bin' }], Quiet: true } }));
      expect(requests).toEqual([
        { method: 'PUT', checksums: { 'content-md5': contentMd5 } },
        { method: 'POST', checksums: { 'x-amz-sdk-checksum-algorithm': 'CRC32', 'x-amz-checksum-crc32': expect.stringMatching(/^[A-Za-z0-9+/]{6}==$/) } }
      ]);
    } finally {
      client.destroy();
    }
  });

  it('requires credentials before constructing a client', () => {
    expect(() => r2ClientOptions({ ...env, R2_SECRET_ACCESS_KEY: '' })).toThrow(/R2_SECRET_ACCESS_KEY/);
  });
});
