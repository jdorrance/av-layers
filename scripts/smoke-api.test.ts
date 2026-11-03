import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { manifestSchema } from '@av/contracts';
import { ApiClient, type PinnedBuild } from '@av/contracts/client';
import { verifyPublishedForecast, probeApi, readResponseBytes, validateHealthContract, verifyWorkerReadiness } from './smoke-api';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const deploymentId = `${'a'.repeat(40)}-12345-2`;

describe('Worker deployment identity smoke check', () => {
  it('requires the exact current deployment when CI supplies a marker', () => {
    expect(() => validateHealthContract({ ok: true, deploymentId }, deploymentId)).not.toThrow();
    for (const actual of [undefined, `${'b'.repeat(40)}-12345-2`, `${'a'.repeat(40)}-12344-2`, `${'a'.repeat(40)}-12345-1`]) {
      expect(() => validateHealthContract({ ok: true, deploymentId: actual }, deploymentId)).toThrow(/expected Worker deployment marker/);
    }
    expect(() => validateHealthContract({ ok: true, deploymentId: '' }, '')).toThrow(/expected Worker deployment marker/);
  });

  it('allows unmarked local development while still requiring healthy responses', () => {
    expect(() => validateHealthContract({ ok: true })).not.toThrow();
    for (const health of [null, {}, { ok: false }, { ok: 'true' }]) {
      expect(() => validateHealthContract(health)).toThrow(/ok:true/);
    }
  });
});


describe('Worker readiness after deployment', () => {
  const url = 'https://api.example/healthz';

  it.each([404, 503])('retries HTTP %s while the deployment propagates', async status => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('not ready', { status }))
      .mockResolvedValueOnce(Response.json({ ok: true, deploymentId }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl).toHaveBeenCalledWith(url, expect.objectContaining({ headers: { accept: 'application/json' } }));
  });

  it.each([undefined, `${'a'.repeat(40)}-12344-2`])('waits for the exact deployment after marker %s', async actual => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(Response.json({ ok: true, deploymentId: actual }))
      .mockResolvedValueOnce(Response.json({ ok: true, deploymentId }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits through a rollout that keeps serving the previous version for 25 seconds', async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    const fetchImpl = vi.fn(async () => Response.json({
      ok: true, deploymentId: Date.now() - startedAt >= 25_000 ? deploymentId : 'previous'
    }));
    const ready = expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl })).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(25_000);
    await ready;
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it('fails after the default bounded retries if the URL keeps serving a different deployment', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, deploymentId: `${'b'.repeat(40)}-12345-2` }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, delayMs: 0 })).rejects.toThrow(/Worker readiness verification failed:.*expected Worker deployment marker/);
    expect(fetchImpl).toHaveBeenCalledTimes(13);
  });

  it('reports the final HTTP failure when readiness never succeeds', async () => {
    const fetchImpl = vi.fn(async () => new Response('not ready', { status: 404 }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).rejects.toThrow(/Worker readiness verification failed: status 404/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries connection failures and reports them after exhaustion', async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new TypeError('connection reset'))
      .mockResolvedValueOnce(Response.json({ ok: true, deploymentId }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const failing = vi.fn().mockRejectedValue(new TypeError('connection reset'));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl: failing, retries: 1, delayMs: 0 })).rejects.toThrow(/Worker readiness verification failed: connection reset/);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it.each(['headers', 'body'])('aborts stalled %s and retries with a fresh deadline', async stage => {
    let stalledSignal: AbortSignal;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(async (_url, init) => {
      stalledSignal = init!.signal!;
      if (stage === 'headers') {
        return new Promise<Response>((_resolve, reject) => {
          stalledSignal.addEventListener('abort', () => reject(stalledSignal.reason), { once: true });
        });
      }
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":'));
          stalledSignal.addEventListener('abort', () => controller.error(stalledSignal.reason), { once: true });
        }
      }));
    }).mockImplementationOnce(async (_url, init) => {
      expect(stalledSignal.aborted).toBe(true);
      expect(init!.signal).not.toBe(stalledSignal);
      expect(init!.signal!.aborted).toBe(false);
      return Response.json({ ok: true, deploymentId });
    });
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0, timeoutMs: 20 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});


it('bounds the complete publication check even when nested readiness retries keep failing', async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('Probe deadline reached')), milliseconds);
    return controller.signal;
  });
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('offline', { status: 503 }));
  const result = expect(verifyPublishedForecast({ baseUrl: 'https://api.example', manifest, fetchImpl })).rejects.toThrow('Probe deadline reached');
  await vi.advanceTimersByTimeAsync(60_000);
  await result;
  const calls = fetchImpl.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fetchImpl).toHaveBeenCalledTimes(calls);
});

it('rejects oversized declared or streamed probe bodies and cancels the stream', async () => {
  const cancel = vi.fn();
  const declared = new Response(new ReadableStream({ cancel }), { headers: { 'content-length': '17' } });
  await expect(readResponseBytes(declared, 16)).rejects.toThrow('byte limit');
  expect(cancel).toHaveBeenCalledOnce();
  const streamed = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel }));
  await expect(readResponseBytes(streamed, 16)).rejects.toThrow('byte limit');
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('uses one pinned build for the shared sample/tile probe and propagates serving failures', async () => {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  const build: PinnedBuild = { manifest, expiresAtMs: Date.parse(manifest.expiresAt), templates: Object.fromEntries(manifest.layers.map(layer => [layer, 'unused'])) as PinnedBuild['templates'] };
  const latest = vi.spyOn(ApiClient.prototype, 'latest').mockResolvedValue(build);
  const sample = vi.spyOn(ApiClient.prototype, 'sample').mockResolvedValue({ model: manifest.model, buildId: manifest.buildId, lat: 32.9, lon: -117.25, method: manifest.method, source: manifest.source, coverage: manifest.coverage, expiresAt: manifest.expiresAt, frames: [] });
  let corruptTile = false;
  await expect(probeApi({ baseUrl: 'https://api.example', model: manifest.model, fetchImpl: async input => {
    const path = new URL(String(input)).pathname;
    return Response.json(path === '/healthz' ? { ok: true } : { models: [{ model: manifest.model, available: true }] });
  }, expectedModels: [manifest.model, 'another-model'] })).rejects.toThrow('Catalog omitted');
  const fetchImpl = vi.fn<typeof fetch>(async input => {
    const path = new URL(String(input)).pathname;
    if (path === '/healthz') return Response.json({ ok: true, deploymentId });
    if (path === '/v1/catalog') return Response.json({ models: [{ model: manifest.model, available: true }] });
    if (path.endsWith('/runs')) return Response.json({ retained: [{ buildId: manifest.buildId }] });
    expect(path).toBe(`/tiles/${manifest.model}/${manifest.buildId}/${manifest.layers[0]}/${manifest.frames[0].id}/0/0/0.webp`);
    return new Response(corruptTile ? 'corrupt' : 'RIFF1234WEBP0000000000000000', { headers: { 'content-type': 'image/webp', 'access-control-allow-origin': '*', 'cache-control': 'public,max-age=60' } });
  });
  const options = { baseUrl: 'https://api.example', model: manifest.model, expectedDeploymentId: deploymentId, fetchImpl };
  expect(await probeApi(options)).toBe(manifest);
  await expect(probeApi({ ...options, expectedBuild: { ...manifest, buildId: 'newer-build' } })).rejects.toThrow('Latest API build');
  await expect(probeApi({ ...options, expectedBuild: { ...manifest, frames: manifest.frames.slice(1) } })).rejects.toThrow('frame or layer');
  await expect(probeApi({ ...options, expectedBuild: { ...manifest, layers: ['usable-lift-agl'] } })).rejects.toThrow('frame or layer');
  latest.mockResolvedValueOnce({ ...build, manifest: { ...manifest, buildId: 'previous-build' } });
  await expect(verifyPublishedForecast({ ...options, manifest, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
  const cancelled = AbortSignal.abort(new Error('Publication interrupted'));
  const calls = fetchImpl.mock.calls.length;
  await expect(verifyPublishedForecast({ ...options, manifest, signal: cancelled })).rejects.toThrow('Publication interrupted');
  expect(fetchImpl.mock.calls.length).toBe(calls);
  expect(latest).toHaveBeenCalledWith(manifest.model, { requireLive: true });
  expect(sample).toHaveBeenCalledWith(build, { lat: (manifest.descriptors.bounds[1] + manifest.descriptors.bounds[3]) / 2, lon: (manifest.descriptors.bounds[0] + manifest.descriptors.bounds[2]) / 2, frames: [manifest.frames[0].id], signal: undefined });
  corruptTile = true;
  const observeManifest = vi.fn();
  await expect(probeApi({ ...options, requireLive: false, observeManifest })).rejects.toThrow('not WebP');
  expect(observeManifest).toHaveBeenCalledWith(manifest);
  expect(latest).toHaveBeenLastCalledWith(manifest.model, { requireLive: false, signal: undefined });
  sample.mockRejectedValueOnce(new Error('sample unavailable'));
  await expect(probeApi(options)).rejects.toThrow('sample unavailable');
});
