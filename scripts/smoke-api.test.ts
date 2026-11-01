import { describe, expect, it, vi } from 'vitest';
import { validateHealthContract, verifyWorkerReadiness } from './smoke-api';

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

  it('fails after the default bounded retries if the URL keeps serving a different deployment', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true, deploymentId: `${'b'.repeat(40)}-12345-2` }));
    await expect(verifyWorkerReadiness({ url, expectedDeploymentId: deploymentId, fetchImpl, delayMs: 0 })).rejects.toThrow(/Worker readiness verification failed:.*expected Worker deployment marker/);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
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
