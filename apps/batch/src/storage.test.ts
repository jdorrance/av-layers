import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { r2ClientOptions, r2Storage } from './storage';

const env = { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' };

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
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('manifest')).rejects.toThrow('response length');
      expect(send).toHaveBeenCalledTimes(1);
    }
    finally { send.mockRestore(); }
  });

  it.each(['ECONNRESET', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE'])('restarts a GET after %s without retaining partial bytes', async code => {
    const failed = Readable.from((async function* () { yield Uint8Array.of(99); throw Object.assign(new Error('aborted'), { code }); })());
    const send = vi.spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ ContentLength: 2, ETag: 'etag', Body: failed } as never)
      .mockResolvedValueOnce({ ContentLength: 2, ETag: 'etag', Body: Readable.from([Uint8Array.of(1, 2)]) } as never);
    try {
      const result = await r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2);
      expect([...result!.bytes]).toEqual([1, 2]);
      expect(failed.destroyed).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      for (const [command] of send.mock.calls) expect(command.input).toMatchObject({ Key: 'terrain/tile.tif', Range: 'bytes=7-8' });
    } finally { send.mockRestore(); }
  });

  it('bounds failed body attempts and preserves the final cause with the object range', async () => {
    const failure = Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
    const bodies: Readable[] = [];
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
      const body = Readable.from((async function* () { yield Uint8Array.of(99); throw failure; })());
      bodies.push(body);
      return { ContentLength: 2, ETag: 'etag', Body: body } as never;
    });
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2))
        .rejects.toMatchObject({ message: 'R2 GET terrain/tile.tif (bytes 7–8): aborted [ECONNRESET]', cause: failure });
      expect(send).toHaveBeenCalledTimes(3);
      expect(bodies.every(body => body.destroyed)).toBe(true);
    } finally { send.mockRestore(); }
  });

  it('bounds a stalled response body even after the SDK returned its headers', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stalled = new Readable({ read() {} });
    const send = vi.spyOn(S3Client.prototype, 'send')
      .mockResolvedValueOnce({ ContentLength: 2, ETag: 'etag', Body: stalled } as never)
      .mockResolvedValueOnce({ ContentLength: 2, ETag: 'etag', Body: Readable.from([Uint8Array.of(1, 2)]) } as never);
    try {
      const pending = r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif');
      await nextTurn();
      await vi.advanceTimersByTimeAsync(30_000);
      expect([...(await pending)!.bytes]).toEqual([1, 2]);
      expect(stalled.destroyed).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { send.mockRestore(); vi.useRealTimers(); }
  });

  it.each(['body', 'backoff'])('preserves caller cancellation during %s without another GET', async phase => {
    const controller = new AbortController(), reason = new Error('cancel import');
    const body = phase === 'body' ? new Readable({ read() {} })
      : Readable.from((async function* () { yield Uint8Array.of(99); throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); })());
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 2, ETag: 'etag', Body: body } as never);
    try {
      const pending = r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, controller.signal);
      await nextTurn();
      if (phase === 'backoff') expect(body.destroyed).toBe(true);
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(body.destroyed).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { send.mockRestore(); }
  });

  it.each(['missing-etag', 'declared-size', 'stream-size', 'unexpected-error'])('does not retry %s and destroys the abandoned body', async failure => {
    const body = failure === 'unexpected-error'
      ? Readable.from((async function* () { yield new Uint8Array(); throw new Error('invalid stream'); })())
      : Readable.from([Uint8Array.of(1, 2, 3)]);
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: failure === 'declared-size' ? 3 : 2,
      ETag: failure === 'missing-etag' ? undefined : 'etag', Body: body } as never);
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2)).rejects.toThrow('R2 GET tile');
      expect(send).toHaveBeenCalledTimes(1);
      expect(body.destroyed).toBe(true);
    } finally { send.mockRestore(); }
  });

  it('leaves request failures to SDK retries and retains missing-object behavior', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValueOnce(Object.assign(new Error('request timeout'), { name: 'TimeoutError' }))
      .mockRejectedValueOnce({ $metadata: { httpStatusCode: 404 } });
    try {
      const store = r2Storage({ ...env, R2_BUCKET: 'test' });
      await expect(store.get('tile')).rejects.toThrow('request timeout');
      expect(send).toHaveBeenCalledTimes(1);
      await expect(store.get('missing')).resolves.toBeNull();
      expect(send).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); }
  });

  it('uses the R2 endpoint and required-only SDK checksums', () => {
    const options = r2ClientOptions(env)!;
    expect(options.endpoint).toBe(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`);
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
