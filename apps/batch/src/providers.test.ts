import { beforeEach, expect, it, vi } from 'vitest';
import { INDEXED_GRID, INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures.js';
import { createIndexedGribProvider } from './indexed-grib/provider.js';
import { createSplitGribProvider } from './split-grib/provider.js';
import { recentSourceCycles, sourceCycle } from './source.js';

const state = vi.hoisted(() => ({ loaded: [] as string[], proof: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock('./indexed-grib/acquire.js', () => { state.loaded.push('indexed-acquisition'); return { createIndexedGribAcquisitionSession: vi.fn().mockRejectedValue(new Error('Acquisition invoked')) }; });
vi.mock('./split-grib/acquire.js', () => { state.loaded.push('split-acquisition'); return { createSplitGribAcquisitionSession: vi.fn().mockRejectedValue(new Error('Acquisition invoked')) }; });
vi.mock('./indexed-grib/discover.js', () => { state.loaded.push('indexed-discovery'); return { discoverIndexedGribRun: vi.fn().mockResolvedValue({ cycle: '2026-10-30T00:00:00Z' }) }; });
vi.mock('./split-grib/discover.js', () => { state.loaded.push('split-discovery'); return { discoverSplitGribRun: vi.fn().mockResolvedValue({ cycle: '2026-10-30T00:00:00Z' }) }; });
vi.mock('./input-proof.js', () => ({ proveForecastInputs: state.proof }));
beforeEach(() => { state.loaded.length = 0; state.proof.mockClear(); });

it.each([
  { protocol: 'indexed', product: INDEXED_PRODUCT, create: createIndexedGribProvider },
  { protocol: 'split', product: SPLIT_PRODUCT, create: createSplitGribProvider }
])('binds configured identity and cycles with lazy $protocol acquisition', async ({ protocol, product, create }) => {
  const provider = create(product), cycle = '2026-10-30T00:00:00Z';
  expect(state.loaded).toEqual([]);
  expect(Date.parse(await provider.resolveCycle({ cycle, cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  await expect(provider.resolveCycle({ cycle: '', cacheDir: '/unused' })).rejects.toThrow(/cycle/i);
  await expect(provider.resolveCycle({ cacheDir: '/unused', signal: AbortSignal.abort(new Error('Cancelled')) })).rejects.toThrow('Cancelled');
  expect(state.loaded).toEqual([]);
  expect(Date.parse(await provider.resolveCycle({ cacheDir: '/unused' }))).toBe(Date.parse(cycle));
  expect(state.loaded).toEqual([`${protocol}-discovery`]);
  await expect(provider.open({ cycle, activeIndices: Uint32Array.of(0), cacheDir: '/unused' })).rejects.toThrow('Acquisition invoked');
  expect(state.loaded).toEqual([`${protocol}-discovery`, `${protocol}-acquisition`]);
  expect(state.proof).not.toHaveBeenCalled();
  expect(await provider.proveInputs({ cycle })).toEqual({ ok: true });
  expect(state.proof).toHaveBeenCalledWith(product, provider, { cycle });
  const configured = create({ ...product, modelId: 'configured-model', source: { ...product.source, configurationId: 'configured-source' }, forecast: { ...product.forecast, cycleHoursUtc: [1, 7, 18] } });
  expect(configured.id).toBe('configured-source');
  expect(Date.parse(await configured.resolveCycle({ cycle: '2026-10-30T01:00:00Z', cacheDir: '/unused' }))).toBe(Date.parse('2026-10-30T01:00:00Z'));
});

it('orders irregular configured cycles across dates and rejects inexact UTC timestamps', () => {
  expect(recentSourceCycles(new Date('2026-11-05T12:00:00Z'), [1, 7, 18], 2, 4)).toEqual([
    '2026-11-05T07:00:00.000Z', '2026-11-05T01:00:00.000Z', '2026-11-04T18:00:00.000Z', '2026-11-04T07:00:00.000Z'
  ]);
  for (const value of ['2026-11-05', '2026-02-30T00:00:00Z', '2026-11-05T01:00:00+01:00', '2026-11-05T00:00:01Z']) expect(() => sourceCycle(value, [0])).toThrow('exact ISO UTC');
});

it('refuses unsupported source axes, layer roles and ignored normalization settings before opening input', () => {
  expect(() => createIndexedGribProvider({ ...INDEXED_PRODUCT, capabilities: { ...INDEXED_PRODUCT.capabilities, verticalCoordinate: 'model-levels' } })).toThrow('isobaric');
  expect(() => createSplitGribProvider({ ...SPLIT_PRODUCT, capabilities: { ...SPLIT_PRODUCT.capabilities, verticalCoordinate: 'isobaric' } })).toThrow('model-level');
  const withoutPrecipitation = { ...SPLIT_PRODUCT.upstream, fields: { ...(SPLIT_PRODUCT.upstream.fields as object), precipitation: undefined } };
  expect(() => createSplitGribProvider({ ...SPLIT_PRODUCT, upstream: withoutPrecipitation, layers: [...SPLIT_PRODUCT.layers, 'precip-rate'] })).toThrow('precipitation');
  const upstream = structuredClone(SPLIT_PRODUCT.upstream) as { fields: { temperature2m: Record<string, unknown> } };
  upstream.fields.temperature2m.scale = -1;
  expect(() => createSplitGribProvider({ ...SPLIT_PRODUCT, upstream })).toThrow();
});

it('requires whole-column alignment and preserves unsigned regional origins without rotation', () => {
  expect(() => createIndexedGribProvider({ ...INDEXED_PRODUCT, upstream: { ...INDEXED_PRODUCT.upstream, nativeLongitudeOrigin: 0.1 } })).toThrow('align');
  const regional = { ...INDEXED_PRODUCT, grid: { ...INDEXED_GRID, width: 3, height: 3, lon0: -125, wrapLongitude: false } };
  expect(() => createIndexedGribProvider({ ...regional, upstream: { ...regional.upstream, nativeLongitudeOrigin: 235 } })).not.toThrow();
  expect(() => createIndexedGribProvider({ ...regional, upstream: { ...regional.upstream, nativeLongitudeOrigin: 235.25 } })).toThrow('align');
});
