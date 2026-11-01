import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { parseIdx } from '@azohra/meteo.grib';
import { MAX_NOAA_INDEX_BYTES, NoaaTransport, sha256 } from './transport.ts';

const stamp = '2026103000', url = 'https://example.test/a.idx';
const inventory = `1:0:d=${stamp}:TMP:850 mb:3 hour fcst:\n2:10:d=${stamp}:HGT:850 mb:3 hour fcst:`;
const record = parseIdx(inventory)[0]!;
const retry = { maxAttempts: 3, deadlineMs: 1000, attemptTimeoutMs: 500, baseDelayMs: 0, maxDelayMs: 0 };
afterEach(() => vi.restoreAllMocks());

it('hashes ordered section views exactly without concatenation, including optional/empty sections', () => {
  const backing = Buffer.from('prefix-metadata-encoding-payload');
  const chunks = [backing.subarray(7, 15), new Uint8Array(0), backing.subarray(16, 24)];
  expect(sha256(chunks)).toBe(createHash('sha256').update(Buffer.concat(chunks)).digest('hex'));
  expect(sha256([])).toBe(sha256(''));
  expect(backing.toString()).toBe('prefix-metadata-encoding-payload');
});

it('retries transient status and transport failures with a bounded number of attempts', async () => {
  const fetchImpl = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('connection reset'))
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response(inventory));
  const transport = new NoaaTransport({ fetchImpl, retry });
  expect((await transport.index(url, stamp)).records).toHaveLength(2);
  expect(fetchImpl).toHaveBeenCalledTimes(3);
  expect(transport.stats).toMatchObject({ networkRequests: 3, retries: 2 });
  const failing = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
  await expect(new NoaaTransport({ fetchImpl: failing, retry }).index(url, stamp)).rejects.toMatchObject({ code: 'transport', details: { reason: 'transient-exhausted', attempts: 3 } });
  expect(failing).toHaveBeenCalledTimes(3);
});

it('never retries wrong ranges, missing objects or scientific index identity conflicts', async () => {
  const wrongRange = vi.fn<typeof fetch>(async () => new Response(Buffer.alloc(10), { status: 206, headers: { 'content-range': 'bytes 1-10/20' } }));
  await expect(new NoaaTransport({ fetchImpl: wrongRange, retry }).field(url, record)).rejects.toThrow('Content-Range');
  expect(wrongRange).toHaveBeenCalledOnce();
  const missing = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
  await expect(new NoaaTransport({ fetchImpl: missing, retry }).index(url, stamp)).rejects.toMatchObject({ details: { reason: 'upstream-not-ready' } });
  expect(missing).toHaveBeenCalledOnce();
  const conflicting = vi.fn<typeof fetch>(async () => new Response(inventory));
  await expect(new NoaaTransport({ fetchImpl: conflicting, retry }).index(url, '2026103006')).rejects.toMatchObject({ code: 'source-conflict' });
  expect(conflicting).toHaveBeenCalledOnce();
});

it('cancels retry backoff without starting another request', async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 503 }));
  const transport = new NoaaTransport({ fetchImpl, signal: controller.signal, retry: { ...retry, baseDelayMs: 500, maxDelayMs: 500 } });
  const request = transport.index(url, stamp);
  const rejected = expect(request).rejects.toThrow();
  await vi.waitFor(() => expect(transport.stats.retries).toBe(1));
  controller.abort(new Error('cancel build'));
  await rejected;
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('times out a stalled response body and cancels its stream', async () => {
  let canceled = false;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } })));
  await expect(new NoaaTransport({ fetchImpl, retry: { maxAttempts: 1, deadlineMs: 20, attemptTimeoutMs: 10, baseDelayMs: 0, maxDelayMs: 0 } }).index(url, stamp)).rejects.toMatchObject({ details: { reason: 'timeout' } });
  expect(canceled).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('bounds streamed inventory bytes even when Content-Length lies', async () => {
  let canceled = false, count = 0;
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(++count === 1 ? MAX_NOAA_INDEX_BYTES + 1 : 1)); },
    cancel() { canceled = true; }
  }), { headers: { 'content-length': '10' } }));
  await expect(new NoaaTransport({ fetchImpl, retry }).index(url, stamp)).rejects.toThrow('Oversized NOAA index');
  expect(canceled).toBe(true);
  expect(fetchImpl).toHaveBeenCalledOnce();
});

it('refreshes a deliberately invalidated cached inventory without trusting the old receipt', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'av-noaa-refresh-'));
  try {
    const first = new NoaaTransport({ cacheDir: dir, fetchImpl: async () => new Response(inventory) });
    const original = await first.index(url, stamp);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(`${inventory}\n3:20:d=${stamp}:PRES:surface:3 hour fcst:`));
    const second = new NoaaTransport({ cacheDir: dir, fetchImpl });
    expect((await second.index(url, stamp)).asset.sha256).toBe(original.asset.sha256);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await second.index(url, stamp, true)).records).toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect((await second.index(url, stamp)).records).toHaveLength(3);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
