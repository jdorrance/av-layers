import { describe, expect, it } from 'vitest';
import { validateHealthContract } from './smoke-api';

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
