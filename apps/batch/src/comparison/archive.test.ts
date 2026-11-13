import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureUrl, MAX_ARCHIVE_BYTES, MAX_CAPTURE_BYTES, MAX_CAPTURE_REQUEST_BYTES, MissingCaptureError, readCapture, writeCapture } from './archive.js';

const directories: string[] = [];
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), 'av-comparison-'));
  directories.push(dir); return dir;
}
const url = 'https://forecast.test/point?lat=40&lon=44';
const input = { url, status: 200, body: 'callback({"temperature":12,"name":"été"});\n', capturedAt: '2026-11-13T08:00:00.000Z' };
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

describe('forecast response archive', () => {
  it('round-trips raw JSONP and keeps capture IDs immutable', async () => {
    const dir = await directory(), first = await writeCapture(dir, 'xc-001', input);
    expect(await readCapture(dir, 'xc-001', { url })).toEqual(first);
    expect(first.body).toBe(input.body);
    expect(first.bytes).toBe(Buffer.byteLength(input.body));
    expect(await writeCapture(dir, 'xc-001', { ...input, capturedAt: '2026-11-13T09:00:00.000Z' })).toEqual(first);
    await expect(writeCapture(dir, 'xc-001', { ...input, body: '{}' })).rejects.toThrow('immutable');
    await expect(readCapture(dir, 'xc-001', { url: `${url}&different=1` })).rejects.toThrow('URL differs');
    await expect(writeCapture(dir, 'xc-001', { ...input, url: `${url}&different=1` })).rejects.toThrow('URL differs');
    await expect(readCapture(dir, 'missing')).rejects.toBeInstanceOf(MissingCaptureError);
    await expect(readCapture(dir, '../outside')).rejects.toThrow('filename');
  });

  it('rejects tampered body lengths and hashes on offline replay', async () => {
    const dir = await directory(), captured = await writeCapture(dir, 'one', input);
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...captured, body: captured.body.replace('12', '13') }));
    await expect(readCapture(dir, 'one')).rejects.toThrow('checksum or length');
    await writeFile(join(dir, 'one.json'), JSON.stringify({ ...captured, bytes: captured.bytes + 1 }));
    await expect(readCapture(dir, 'one')).rejects.toThrow('checksum or length');
  });

  it('binds POST captures to the bounded request body without storing it or transport headers', async () => {
    const dir = await directory(), requestBody = JSON.stringify({ hours: ['202611131200'], native_levels: true });
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      expect(init).toMatchObject({ method: 'POST', body: requestBody, redirect: 'error' });
      return new Response('{"temperature":12}', { headers: { 'set-cookie': 'private-value' } });
    });
    const options = { method: 'POST' as const, requestBody, fetch: fetcher };
    const captured = await captureUrl(dir, 'post', url, options);
    expect(captured.requestBodyBytes).toBe(Buffer.byteLength(requestBody));
    expect(captured.requestBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await captureUrl(dir, 'post', url, options)).toEqual(captured);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const disk = await readFile(join(dir, 'post.json'), 'utf8');
    expect(disk).not.toContain('202611131200');
    expect(disk).not.toContain('private-value');
    await expect(captureUrl(dir, 'post', url, { ...options, requestBody: '{}' })).rejects.toThrow('request body differs');
    await expect(captureUrl(dir, 'post', url, { fetch: fetcher })).rejects.toThrow('method differs');
    await expect(writeCapture(dir, 'post', { ...input, method: 'POST', requestBody: '{}' })).rejects.toThrow('request body differs');
    await expect(readCapture(dir, 'post', { url, method: 'POST', requestBody })).resolves.toEqual(captured);
    await expect(captureUrl(dir, 'large-post', url, { ...options, requestBody: 'x'.repeat(MAX_CAPTURE_REQUEST_BYTES + 1) }))
      .rejects.toThrow('request byte budget');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('persists the total budget and serializes simultaneous writes', async () => {
    const dir = await directory();
    await Promise.all([writeCapture(dir, 'a', input), writeCapture(dir, 'b', input)]);
    const stored = (await Promise.all(['a', 'b'].map(id => readFile(join(dir, `${id}.json`))))).reduce((sum, bytes) => sum + bytes.length, 0);
    expect(JSON.parse(await readFile(join(dir, '.capture-budget.json'), 'utf8'))).toEqual({ bytes: stored });
    await writeFile(join(dir, '.capture-budget.json'), JSON.stringify({ bytes: MAX_ARCHIVE_BYTES }));
    await expect(writeCapture(dir, 'c', input)).rejects.toThrow('total byte budget');
    await expect(readCapture(dir, 'c')).rejects.toBeInstanceOf(MissingCaptureError);
  });

  it('waits for a concurrent collector to release the archive lock', async () => {
    const dir = await directory(), lock = join(dir, '.capture-lock');
    await writeFile(lock, '');
    const writing = writeCapture(dir, 'shared', input);
    await new Promise(resolve => setTimeout(resolve, 40));
    await rm(lock);
    expect((await writing).body).toBe(input.body);
  });

  it('bounds waiting for a persistent lock and leaves it owned by the other collector', async () => {
    const dir = await directory(), lock = join(dir, '.capture-lock');
    await writeFile(lock, 'other collector');
    await expect(writeCapture(dir, 'blocked', input)).rejects.toThrow('writer lock timed out');
    expect(await readFile(lock, 'utf8')).toBe('other collector');
    await expect(readCapture(dir, 'blocked')).rejects.toBeInstanceOf(MissingCaptureError);
  });

  it('stores an allowlisted response shape and reuses captures without network access', async () => {
    const dir = await directory();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { headers: { 'set-cookie': 'session=private-value' } }));
    const captured = await captureUrl(dir, 'one', url, { fetch: fetcher });
    expect(Object.keys(captured).sort()).toEqual(['body', 'bytes', 'capturedAt', 'method', 'sha256', 'status', 'url']);
    expect(await readFile(join(dir, 'one.json'), 'utf8')).not.toContain('private-value');
    expect(await captureUrl(dir, 'one', url, { fetch: fetcher })).toEqual(captured);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('retries only 429/503 at most twice and retains the final HTTP status', async () => {
    const dir = await directory();
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(new Response('busy', { status: 503 }));
    expect((await captureUrl(dir, 'busy', url, { fetch: fetcher })).status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const denied = vi.fn<typeof fetch>().mockResolvedValue(new Response('denied', { status: 401 }));
    expect((await captureUrl(dir, 'denied', url, { fetch: denied })).status).toBe(401);
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it('bounds raw ingestion and streamed responses before publication', async () => {
    const dir = await directory();
    await expect(writeCapture(dir, 'large', { ...input, body: 'x'.repeat(MAX_CAPTURE_BYTES + 1) })).rejects.toThrow('response byte budget');
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new Uint8Array(MAX_CAPTURE_BYTES + 1)));
    await expect(captureUrl(dir, 'stream', url, { fetch: fetcher })).rejects.toThrow('response byte budget');
    await expect(readCapture(dir, 'stream')).rejects.toBeInstanceOf(MissingCaptureError);
  });

  it('cancels an outstanding body read and rejects credential-bearing URLs', async () => {
    const dir = await directory(), controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
      queueMicrotask(() => controller.abort(new Error('capture cancelled')));
      return new Response(new ReadableStream());
    });
    await expect(captureUrl(dir, 'abort', url, { fetch: fetcher, signal: controller.signal })).rejects.toThrow('capture cancelled');
    for (const unsafe of ['https://user:password@forecast.test/', 'https://forecast.test/?session_id=private', 'http://forecast.test/']) {
      await expect(writeCapture(dir, 'unsafe', { ...input, url: unsafe })).rejects.toThrow();
    }
  });
});
