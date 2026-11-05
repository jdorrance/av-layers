import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { DeleteObjectsCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { assertBuildBucketLock, r2ClientOptions, r2ShardStorage, r2Storage, sealShardCredentials } from './storage';
import { putImmutable } from './immutable-upload';

const env = { CLOUDFLARE_ACCOUNT_ID: '0123456789abcdef0123456789abcdef', R2_ACCESS_KEY_ID: 'access', R2_SECRET_ACCESS_KEY: 'secret' };
const plan = { model: 'gfs' as const, buildId: '20261104T190000Z-00000000-0000-4000-8000-000000000000', createdAt: '2026-11-04T19:00:00.000Z', deadlineAt: '2026-11-04T19:50:00.000Z' };
const issuer = { ...env, R2_BUCKET: 'bucket', FORECAST_SHARD_CREDENTIAL_KEY: 'ab'.repeat(32) };
const shard = { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, R2_BUCKET: 'bucket', FORECAST_SHARD_CREDENTIAL_KEY: issuer.FORECAST_SHARD_CREDENTIAL_KEY };
const makeStore = (value: typeof plan | (Omit<typeof plan, 'deadlineAt'> & { deadlineAt: string | undefined })) => r2ShardStorage(shard, value, Buffer.from(sealShardCredentials(issuer, value)));
async function withBackoff<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  let settled = false;
  const pending = start().then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));
  void pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    // SDK setup timers and the faked backoff have to run on alternate turns.
    for (let step = 0; step < 40 && !settled; step++) {
      await vi.advanceTimersByTimeAsync(250);
      if (!settled) await new Promise(resolve => { setImmediate(resolve); });
    }
    if (!settled) throw new Error('storage operation did not settle during backoff');
    const result = await pending;
    if (!result.ok) throw result.error;
    return result.value;
  } finally { vi.useRealTimers(); }
}

describe('R2 bucket lock preflight', () => {
  const lockEnv = { CLOUDFLARE_ACCOUNT_ID: env.CLOUDFLARE_ACCOUNT_ID, R2_BUCKET: issuer.R2_BUCKET, CLOUDFLARE_API_TOKEN: 'api-token' };
  const rule = { enabled: true, prefix: 'builds/', condition: { type: 'Age', maxAgeSeconds: 3600 } };
  const response = (rules: unknown, success = true) => Response.json({ success, result: { rules } });
  const futurePlan = () => ({ ...plan, deadlineAt: new Date(Date.now() + 30_000).toISOString() });
  it('accepts covering age, indefinite and sufficiently distant date rules', async () => {
    const current = futurePlan();
    for (const value of [rule, { ...rule, prefix: '', condition: { type: 'Indefinite' } },
      { ...rule, prefix: `builds/${current.model}/${current.buildId}/`, condition: { type: 'Date', date: new Date(Date.parse(current.deadlineAt)).toISOString() } }]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response([value]));
      await assertBuildBucketLock(lockEnv, current, fetchImpl);
      expect(fetchImpl).toHaveBeenCalledWith(`https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/r2/buckets/bucket/lock`, expect.objectContaining({ headers: { authorization: 'Bearer api-token' }, signal: expect.any(AbortSignal) }));
    }
  });
  it('caps the lock request deadline at fifteen seconds', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    try {
      await assertBuildBucketLock(lockEnv, futurePlan(), vi.fn<typeof fetch>().mockResolvedValue(response([rule])));
      expect(timeout).toHaveBeenCalledWith(15_000);
    } finally { timeout.mockRestore(); }
  });
  it('rejects absent, disabled, incomplete, narrow, short and failed rules', async () => {
    const current = futurePlan();
    for (const result of [response([]), response(undefined), response([{ ...rule, enabled: false }]),
      response([{ ...rule, prefix: `builds/${current.model}/${current.buildId}/tiles/` }]),
      response([{ ...rule, prefix: 'builds/icon-eu/' }]), response([{ ...rule, condition: { type: 'Age', maxAgeSeconds: 3599 } }]),
      response([{ ...rule, condition: { type: 'Date', date: new Date(Date.parse(current.deadlineAt) - 1).toISOString() } }]),
      response([rule], false), new Response('', { status: 403 }), new Response('{')]) {
      await expect(assertBuildBucketLock(lockEnv, current, vi.fn<typeof fetch>().mockResolvedValue(result))).rejects.toThrow();
    }
    await expect(assertBuildBucketLock({ ...lockEnv, CLOUDFLARE_API_TOKEN: '' }, current)).rejects.toThrow('API token');
  });
  it.each(['declared', 'streamed'])('bounds %s response bytes', async kind => {
    const result = kind === 'declared' ? new Response('', { headers: { 'content-length': '262145' } }) : new Response(new Uint8Array(262145));
    await expect(assertBuildBucketLock(lockEnv, futurePlan(), vi.fn<typeof fetch>().mockResolvedValue(result))).rejects.toThrow('byte budget');
  });
  it.each(['headers', 'body'])('aborts stalled %s at the plan deadline', async stage => {
    const current = { ...plan, deadlineAt: new Date(Date.now() + 50).toISOString() };
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
      const signal = init!.signal!;
      if (stage === 'headers') return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      return new Response(new ReadableStream({ start() {} }));
    });
    await expect(assertBuildBucketLock(lockEnv, current, fetchImpl)).rejects.toThrow();
  });
});

describe('R2 shard credentials', () => {
  it('signs separate action and path scoped credentials used by the SDK', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T19:10:00.000Z'));
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async command => {
      if (command.constructor.name === 'GetObjectCommand') return { ContentLength: 1, ETag: 'etag', Body: Readable.from([Uint8Array.of(1)]) } as never;
      return { ContentLength: 1, ETag: 'etag' } as never;
    });
    try {
      const store = makeStore(plan);
      await store.get('coverage/test');
      await store.head('coverage/test');
      await store.put('builds/test', Uint8Array.of(1), {});
      await expect(store.list('')).rejects.toThrow('cannot list');
      await expect(store.delete(['key'])).rejects.toThrow('cannot delete');
      expect(send).toHaveBeenCalledTimes(3);
      const credentials = await Promise.all(send.mock.contexts.map(client => (client as S3Client).config.credentials()));
      expect(credentials[0]).toEqual(credentials[1]);
      expect(credentials[0]).not.toEqual(credentials[2]);
      const prefix = `builds/${plan.model}/${plan.buildId}/`;
      for (const [index, actions, prefixPaths] of [[0, ['GetObject', 'HeadObject'], [prefix, 'coverage/', 'terrain/prepared/']], [2, ['PutObject'], [prefix]]] as const) {
        const credential = credentials[index]!;
        expect(credential.accessKeyId).toBe(env.R2_ACCESS_KEY_ID);
        const token = Buffer.from(credential.sessionToken!, 'base64').toString();
        expect(token.startsWith('jwt/')).toBe(true);
        const jwt = token.slice(4), [header, payload, signature] = jwt.split('.');
        expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
        expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({
          bucket: 'bucket', actions, paths: { prefixPaths, objectPaths: [] },
          sub: env.CLOUDFLARE_ACCOUNT_ID, iss: env.R2_ACCESS_KEY_ID, aud: `${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
          iat: Date.parse('2026-11-04T19:10:00.000Z') / 1000, exp: Date.parse(plan.deadlineAt) / 1000
        });
        expect(signature).toBe(createHmac('sha256', env.R2_SECRET_ACCESS_KEY).update(`${header}.${payload}`).digest('base64url'));
        expect(credential.secretAccessKey).toBe(createHash('sha256').update(jwt).digest('hex'));
      }
    } finally { send.mockRestore(); clock.mockRestore(); }
  });

  it('caps expiry at one hour and rejects expired or invalid deadlines', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T19:10:00.000Z'));
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ ContentLength: 1, ETag: 'etag' } as never);
    try {
      await makeStore({ ...plan, deadlineAt: '2026-11-04T22:00:00.000Z' }).head('key');
      const credentials = await (send.mock.contexts[0] as S3Client).config.credentials();
      const jwt = Buffer.from(credentials.sessionToken!, 'base64').toString().slice(4);
      expect(JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()).exp).toBe(Date.parse('2026-11-04T20:10:00.000Z') / 1000);
      await makeStore({ ...plan, deadlineAt: undefined }).head('key');
      const fallback = await (send.mock.contexts[1] as S3Client).config.credentials();
      const fallbackJwt = Buffer.from(fallback.sessionToken!, 'base64').toString().slice(4);
      expect(JSON.parse(Buffer.from(fallbackJwt.split('.')[1]!, 'base64url').toString()).exp).toBe(Date.parse(plan.deadlineAt) / 1000);
      for (const deadlineAt of ['2026-11-04T19:10:00.000Z', 'invalid']) expect(() => makeStore({ ...plan, deadlineAt })).toThrow('deadline');
      expect(() => makeStore({ ...plan, buildId: '../other' })).toThrow('identity');
    } finally { send.mockRestore(); clock.mockRestore(); }
  });

  it('authenticates the envelope, key and every plan identity field', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-04T19:10:00.000Z'));
    try {
      const envelope = sealShardCredentials(issuer, plan), parsed = JSON.parse(envelope);
      expect(envelope).not.toContain(env.R2_SECRET_ACCESS_KEY);
      expect(envelope).not.toContain('sessionToken');
      expect(sealShardCredentials(issuer, plan)).not.toBe(envelope);
      const open = (environment = shard, identity = plan, data = envelope) => r2ShardStorage(environment, identity, Buffer.from(data));
      expect(() => open()).not.toThrow();
      expect(() => open({ ...shard, FORECAST_SHARD_CREDENTIAL_KEY: 'cd'.repeat(32) })).toThrow('unauthenticated');
      expect(() => open({ ...shard, R2_BUCKET: 'other' })).toThrow('unauthenticated');
      expect(() => open(shard, { ...plan, model: 'icon-eu' as 'gfs' })).toThrow('unauthenticated');
      expect(() => open(shard, { ...plan, buildId: plan.buildId.replace(/0$/, '1') })).toThrow('unauthenticated');
      expect(() => open(shard, { ...plan, deadlineAt: '2026-11-04T19:51:00.000Z' })).toThrow('unauthenticated');
      const ciphertext = Buffer.from(parsed.ciphertext, 'base64'); ciphertext[0] ^= 1;
      expect(() => open(shard, plan, JSON.stringify({ ...parsed, ciphertext: ciphertext.toString('base64') }))).toThrow('unauthenticated');
      expect(() => open(shard, plan, '{}')).toThrow('unauthenticated');
      const iv = Buffer.alloc(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(shard.FORECAST_SHARD_CREDENTIAL_KEY, 'hex'), iv);
      cipher.setAAD(Buffer.from(JSON.stringify([shard.R2_BUCKET, plan.model, plan.buildId, plan.deadlineAt])));
      const malformed = Buffer.concat([cipher.update(JSON.stringify({ read: {}, write: {} })), cipher.final()]);
      expect(() => open(shard, plan, JSON.stringify({ iv: iv.toString('base64'), ciphertext: malformed.toString('base64'), tag: cipher.getAuthTag().toString('base64') }))).toThrow('unauthenticated');
      expect(() => open({ ...shard, FORECAST_SHARD_CREDENTIAL_KEY: '' })).toThrow('FORECAST_SHARD_CREDENTIAL_KEY');
      expect(() => open(shard, plan, 'x'.repeat(16 * 1024 + 1))).toThrow('byte budget');
      expect(() => sealShardCredentials({ ...issuer, R2_ACCESS_KEY_ID: 'a'.repeat(20_000) }, plan)).toThrow('byte budget');
    } finally { clock.mockRestore(); }
  });
});

describe('R2 S3 client configuration', () => {
  it('reconciles a lock 409 by proving the raced object byte-for-byte', async () => {
    const bytes = Buffer.from('immutable'), digest = createHash('sha256').update(bytes).digest('hex');
    const head = vi.fn().mockResolvedValueOnce(null).mockResolvedValue({ size: bytes.length, etag: 'existing', metadata: { sha256: digest } });
    const get = vi.fn().mockResolvedValue({ bytes, etag: 'existing' });
    const put = vi.fn().mockRejectedValue(Object.assign(new Error('ObjectLockedByBucketPolicy'), { $metadata: { httpStatusCode: 409 } }));
    await expect(putImmutable({ head, get, put }, 'key', bytes, 'application/octet-stream', undefined, true)).resolves.toBeUndefined();
    expect(put).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    head.mockReset().mockResolvedValueOnce(null).mockResolvedValue({ size: bytes.length, etag: 'existing', metadata: { sha256: digest } });
    get.mockResolvedValue({ bytes: Buffer.from('different'), etag: 'existing' });
    await expect(putImmutable({ head, get, put }, 'key', bytes, 'application/octet-stream', undefined, true)).rejects.toThrow('hash mismatch');
  });

  it('fails a successful multi-delete response containing locked object errors', async () => {
    const send = vi.spyOn(S3Client.prototype, 'send').mockResolvedValue({ Errors: [{ Key: 'key', Code: 'ObjectLockedByBucketPolicy' }] } as never);
    try { await expect(r2Storage({ ...env, R2_BUCKET: 'test' }).delete(['key'])).rejects.toThrow('ObjectLockedByBucketPolicy'); }
    finally { send.mockRestore(); }
  });
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
      const result = await withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2));
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
      await expect(withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2, undefined, onRetry))).rejects.toThrow('transfer budget exceeded');
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
      const result = await withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', { offset: 0, length: 2 }, 2, undefined, onRetry));
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
      const result = await withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', { offset: 0, length: 2 }, 2, undefined, onRetry));
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
      await expect(withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry))).rejects.toThrow('unavailable');
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
      await expect(withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('tile', undefined, 2, undefined, onRetry))).rejects.toThrow('transfer budget exceeded');
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
      await expect(withBackoff(() => r2Storage({ ...env, R2_BUCKET: 'test' }).get('terrain/tile.tif', { offset: 7, length: 2 }, 2)))
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
      await vi.advanceTimersByTimeAsync(250);
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

  it.each(['deadline', 'cancellation'])('preserves the %s reason when the SDK aborts a HEAD request', async kind => {
    const controller = new AbortController();
    const reason = kind === 'deadline' ? new DOMException('The operation was aborted due to timeout', 'TimeoutError') : new Error('Publication interrupted');
    const send = vi.spyOn(S3Client.prototype, 'send').mockImplementation(async () => {
      controller.abort(reason);
      throw Object.assign(new Error('Request aborted'), { name: 'AbortError' });
    });
    try {
      const store = r2Storage({ ...env, R2_BUCKET: 'test' });
      await expect(store.head('terrain/checkpoints/window.bin', controller.signal)).rejects.toBe(reason);
      expect(send).toHaveBeenCalledOnce();
    } finally { send.mockRestore(); }
  });

  it('uses the R2 endpoint and required-only SDK checksums', () => {
    const options = r2ClientOptions(env)!;
    expect(options.endpoint).toBe(`https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    expect(options.requestChecksumCalculation).toBe('WHEN_REQUIRED');
    expect(options.responseChecksumValidation).toBe('WHEN_REQUIRED');
    expect(r2ClientOptions({ ...env, R2_SESSION_TOKEN: 'session' }).credentials).toEqual({ accessKeyId: 'access', secretAccessKey: 'secret', sessionToken: 'session' });
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
