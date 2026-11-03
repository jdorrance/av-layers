import { expect, it, vi } from 'vitest';
import { gfsProvider } from './provider.js';

const state = vi.hoisted(() => ({ loaded: [] as string[] }));

vi.mock('./acquire.js', () => {
  state.loaded.push('acquisition');
  return { createGfsAcquisitionSession: vi.fn().mockRejectedValue(new Error('Acquisition invoked')) };
});
vi.mock('./prove.js', () => {
  state.loaded.push('proof');
  return { proveGfsInputs: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock('./discover.js', () => {
  state.loaded.push('discovery');
  return { discoverGfsRun: vi.fn().mockResolvedValue({ cycle: '2026-10-30T00:00:00Z' }) };
});

it('loads GFS discovery, acquisition and proof only when requested', async () => {
  const cycle = '2026-10-30T00:00:00Z';
  expect(state.loaded).toEqual([]);
  expect(Date.parse(await gfsProvider.resolveCycle({ cycle, cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  await expect(gfsProvider.resolveCycle({ cycle: '', cacheDir: '/unused' })).rejects.toThrow(/cycle/i);
  const signal = AbortSignal.abort(new Error('Cancelled before discovery'));
  await expect(gfsProvider.resolveCycle({ cacheDir: '/unused', signal })).rejects.toThrow('Cancelled before discovery');
  expect(state.loaded).toEqual([]);

  expect(Date.parse(await gfsProvider.resolveCycle({ cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  expect(state.loaded).toEqual(['discovery']);
  await expect(gfsProvider.open({ cycle, activeIndices: Uint32Array.of(0), cacheDir: '/unused' })).rejects.toThrow('Acquisition invoked');
  expect(state.loaded).toEqual(['discovery', 'acquisition']);
  expect(await gfsProvider.proveInputs({ cycle })).toEqual({ ok: true });
  expect(state.loaded).toEqual(['discovery', 'acquisition', 'proof']);
});
