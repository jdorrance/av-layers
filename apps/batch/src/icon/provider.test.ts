import { expect, it, vi } from 'vitest';
import { iconEuProvider } from './provider.js';

const state = vi.hoisted(() => ({ loaded: [] as string[] }));

vi.mock('./acquire.js', () => {
  state.loaded.push('acquisition');
  return { createIconEuAcquisitionSession: vi.fn().mockRejectedValue(new Error('Acquisition invoked')) };
});
vi.mock('./prove.js', () => {
  state.loaded.push('proof');
  return { proveIconEuInputs: vi.fn().mockResolvedValue({ ok: true }) };
});
vi.mock('./discover.js', () => {
  state.loaded.push('discovery');
  return { discoverIconEuRun: vi.fn().mockResolvedValue({ cycle: '2026-10-30T00:00:00Z' }) };
});

it('loads ICON-EU discovery, acquisition and proof only when requested', async () => {
  const cycle = '2026-10-30T00:00:00Z';
  expect(state.loaded).toEqual([]);
  expect(Date.parse(await iconEuProvider.resolveCycle({ cycle, cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  await expect(iconEuProvider.resolveCycle({ cycle: '', cacheDir: '/unused' })).rejects.toThrow(/cycle/i);
  const signal = AbortSignal.abort(new Error('Cancelled before discovery'));
  await expect(iconEuProvider.resolveCycle({ cacheDir: '/unused', signal })).rejects.toThrow('Cancelled before discovery');
  expect(state.loaded).toEqual([]);

  expect(Date.parse(await iconEuProvider.resolveCycle({ cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  expect(state.loaded).toEqual(['discovery']);
  await expect(iconEuProvider.open({ cycle, activeIndices: Uint32Array.of(0), cacheDir: '/unused' })).rejects.toThrow('Acquisition invoked');
  expect(state.loaded).toEqual(['discovery', 'acquisition']);
  expect(await iconEuProvider.proveInputs({ cycle })).toEqual({ ok: true });
  expect(state.loaded).toEqual(['discovery', 'acquisition', 'proof']);
});
