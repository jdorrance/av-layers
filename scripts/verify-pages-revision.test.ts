import { describe, expect, it, vi } from 'vitest';
import { deploymentMarker, verifyPagesRevision } from './verify-pages-revision';

const deploymentId = `${'a'.repeat(40)}-12345-1`;
const marker = deploymentMarker(deploymentId);

describe('Pages deployment revision verification', () => {
  it('accepts HTML with the exact marker for the deployed commit', async () => {
    const fetchImpl = vi.fn(async () => new Response(`<meta ${marker} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl })).resolves.toBeUndefined();
  });

  it('rejects stale, missing, quoted-mismatched and failed responses', async () => {
    const stale = vi.fn(async () => new Response(`<meta ${deploymentMarker(`${'b'.repeat(40)}-12345-1`)} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: stale, retries: 0 })).rejects.toThrow(/does not contain/);
    const sameCommitOlderRun = vi.fn(async () => new Response(`<meta ${deploymentMarker(`${'a'.repeat(40)}-12344-1`)} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: sameCommitOlderRun, retries: 0 })).rejects.toThrow(/does not contain/);
    const missing = vi.fn(async () => new Response('<meta name="build-deployment" content="" />'));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: missing, retries: 0 })).rejects.toThrow(/does not contain/);
    const failed = vi.fn(async () => new Response('unavailable', { status: 503 }));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl: failed, retries: 0 })).rejects.toThrow(/status 503/);
  });

  it('retries a transient stale response and then succeeds', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response('<meta name="build-deployment" content="stale" />'))
      .mockResolvedValueOnce(new Response(`<meta ${marker} />`));
    await expect(verifyPagesRevision({ url: 'https://preview.example/', expectedDeploymentId: deploymentId, fetchImpl, retries: 1, delayMs: 0 })).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects identifiers that are not commit-run-attempt values', () => {
    expect(() => deploymentMarker('main')).toThrow(/commit SHA, run ID and run attempt/);
    expect(() => deploymentMarker('a'.repeat(40))).toThrow(/commit SHA, run ID and run attempt/);
  });
});
