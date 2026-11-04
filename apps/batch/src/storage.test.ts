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

  it('admits each retry before transferring another response body', async () => {
    const failed = Readable.from((async function* () { yield Uint8Array.of(99); throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); })());
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValueOnce({ ContentLength: 2, ETag: 'etag', Body: failed } as never);
    const onRetry = vi.fn(() => { throw new Error('transfer budget exceeded'); });
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2, undefined, onRetry)).rejects.toThrow('transfer budget exceeded');
      expect(onRetry).toHaveBeenCalledOnce();
      expect(send).toHaveBeenCalledOnce();
      expect(failed.destroyed).toBe(true);
      expect(await (send.mock.contexts[0] as S3Client).config.maxAttempts()).toBe(1);
    } finally { send.mockRestore(); }
  });

  it.each([
    Object.assign(new Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(new Error('timeout'), { name: 'TimeoutError' }),
    Object.assign(new Error('throttled'), { $metadata: { httpStatusCode: 429 } }),
    Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } })
  ])('retries a budgeted transport failure before the body: $message', async failure => {
    const order: string[] = [];
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => { order.push('send'); throw failure; })
      .mockImplementationOnce(async () => { order.push('send'); return { ContentLength: 2, ETag: 'etag', Body: Readable.from([Uint8Array.of(1, 2)]) } as never; });
    const onRetry = vi.fn(() => { order.push('reserve'); });
    try {
      const result = await r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', { offset: 0, length: 2 }, 2, undefined, onRetry);
      expect([...result!.bytes]).toEqual([1, 2]);
      expect(order).toEqual(['send', 'reserve', 'send']);
      expect(await (send.mock.contexts[0] as S3Client).config.maxAttempts()).toBe(1);
    } finally { send.mockRestore(); }
  });

  it('shares three attempts across transport and partial-body failures', async () => {
    const order: string[] = [], failed = Readable.from((async function* () { yield Uint8Array.of(99); throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' }); })());
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementationOnce(async () => { order.push('send'); throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); })
      .mockImplementationOnce(async () => { order.push('send'); return { ContentLength: 2, ETag: 'etag', Body: failed } as never; })
      .mockImplementationOnce(async () => { order.push('send'); return { ContentLength: 2, ETag: 'etag', Body: Readable.from([Uint8Array.of(1, 2)]) } as never; });
    const onRetry = vi.fn(() => { order.push('reserve'); });
    try {
      const result = await r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', { offset: 0, length: 2 }, 2, undefined, onRetry);
      expect([...result!.bytes]).toEqual([1, 2]);
      expect(order).toEqual(['send', 'reserve', 'send', 'reserve', 'send']);
      expect(failed.destroyed).toBe(true);
    } finally { send.mockRestore(); }
  });

  it('cancels an HTTP error body before SDK deserialization and retries its status', async () => {
    const original = S3Client.prototype.send, body = Readable.from([Buffer.alloc(4096)]), order: string[] = [];
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (this: S3Client, command, options) {
      this.config.requestHandler = { handle: async () => {
        order.push('send');
        return { response: order.filter(value => value === 'send').length === 1
          ? { statusCode: 503, headers: { 'content-length': '4096' }, body }
          : { statusCode: 206, headers: { 'content-length': '2', etag: 'etag' }, body: Readable.from([Uint8Array.of(1, 2)]) } };
      } } as typeof this.config.requestHandler;
      return Reflect.apply(original, this, [command, options]) as never;
    } as typeof S3Client.prototype.send);
    try {
      const result = await r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', { offset: 0, length: 2 }, 2, undefined, () => { order.push('reserve'); });
      expect([...result!.bytes]).toEqual([1, 2]);
      expect(order).toEqual(['send', 'reserve', 'send']);
      expect(body.destroyed).toBe(true);
      expect(send).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); }
  });

  it.each(['declared', 'streamed'])('bounds an SDK error body with %s oversize', async kind => {
    const original = S3Client.prototype.send, body = Readable.from([Buffer.alloc(32)]);
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(function (this: S3Client, command, options) {
      this.config.requestHandler = { handle: async () => ({ response: { statusCode: 400, headers: kind === 'declared' ? { 'content-length': '32' } : {}, body } }) } as typeof this.config.requestHandler;
      return Reflect.apply(original, this, [command, options]) as never;
    } as typeof S3Client.prototype.send);
    const onRetry = vi.fn();
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry)).rejects.toThrow('read byte budget');
      expect(send).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
      expect(body.destroyed).toBe(true);
    } finally { send.mockRestore(); }
  });

  it('stops after three failed budgeted transport attempts', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('unavailable'), { $metadata: { httpStatusCode: 503 } }));
    const onRetry = vi.fn();
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry)).rejects.toThrow('unavailable');
      expect(send).toHaveBeenCalledTimes(3);
      expect(onRetry).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); }
  });

  it('cancels a budgeted transport retry during backoff', async () => {
    const controller = new AbortController(), reason = new Error('cancel request');
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    const onRetry = vi.fn();
    try {
      const pending = r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, controller.signal, onRetry);
      await nextTurn();
      controller.abort(reason);
      await expect(pending).rejects.toBe(reason);
      expect(send).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });

  it.each([403, 404])('does not retry a budgeted HTTP %i response', async status => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('denied'), { $metadata: { httpStatusCode: status }, $retryable: {} }));
    const onRetry = vi.fn();
    try {
      const pending = r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry);
      if (status === 404) await expect(pending).resolves.toBeNull();
      else await expect(pending).rejects.toThrow('denied');
      expect(send).toHaveBeenCalledOnce();
      expect(onRetry).not.toHaveBeenCalled();
    } finally { send.mockRestore(); }
  });

  it('stops before a transport retry when admission fails', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockRejectedValue(Object.assign(new Error('reset'), { code: 'ECONNRESET' }));
    const onRetry = vi.fn(() => { throw new Error('transfer budget exceeded'); });
    try {
      await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry)).rejects.toThrow('transfer budget exceeded');
      expect(send).toHaveBeenCalledOnce();
      expect(onRetry).toHaveBeenCalledOnce();
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

  it('preserves object digest metadata on immutable puts and heads', async () => {
    const metadata = { sha256: 'a'.repeat(64) };
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 2, ETag: 'etag', Metadata: metadata } as never);
    try {
      const store = r2Storage({ ...env, R2_BUCKET: 'test' });
      await store.put('shard', Uint8Array.of(1, 2), { ifNoneMatch: '*' }, 'application/octet-stream', undefined, metadata);
      expect(send.mock.calls[0][0].input).toMatchObject({ Metadata: metadata, IfNoneMatch: '*' });
      expect(await store.head('shard')).toEqual({ size: 2, etag: 'etag', metadata });
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
