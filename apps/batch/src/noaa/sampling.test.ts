import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ createPool: vi.fn(), sample: vi.fn() }));
vi.mock('@azohra/meteo.grib/j2k-node', () => ({ createNodeJ2kDecoderPool: mocks.createPool }));
vi.mock('@azohra/meteo.grib', () => ({ sampleFieldValuesAsync: mocks.sample }));
import { compactNoaaSamples, NoaaFieldSampler } from './sampling.ts';
import type { InspectedGfsField } from './admission.ts';
beforeEach(() => { mocks.createPool.mockReset(); mocks.sample.mockReset(); });
const field = (packing: number) => ({ packing, field: {} } as InspectedGfsField);

it('writes instantaneous values directly to Float32 with the same rounding and missing-count boundary', async () => {
  const raw = Float64Array.of(1.23456789123, -0, 5, Infinity, 1e40), mask = Uint8Array.of(0, 0, 1, 0, 0);
  const original = compactNoaaSamples(raw, mask, 5);
  mocks.sample.mockResolvedValue({ values: raw, missingMask: mask });
  const sampler = new NoaaFieldSampler(), destination = new Float32Array(5);
  const result = await sampler.sample(field(3), Uint32Array.of(0, 1, 2, 3, 4), destination);
  expect(result.values).toBe(destination);
  expect(Buffer.from(result.values.buffer)).toEqual(Buffer.from(Float32Array.from(original.values).buffer));
  expect(result.missing).toEqual(original.missing); expect(result.missingCount).toBe(2);
  expect(sampler.stats['3']).toMatchObject({ records: 1, failures: 0, sampledValues: 5 });
  expect(mocks.createPool).not.toHaveBeenCalled();
  await sampler.close();
});

it('shares a single lazy J2K initialization across concurrent samples and closes it once', async () => {
  let ready!: (pool: object) => void;
  mocks.createPool.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  mocks.sample.mockResolvedValue({ values: Float64Array.of(7) });
  const sampler = new NoaaFieldSampler();
  const a = sampler.sample(field(40), Uint32Array.of(0)), b = sampler.sample(field(40), Uint32Array.of(0));
  expect(mocks.createPool).toHaveBeenCalledTimes(1); expect(mocks.sample).not.toHaveBeenCalled();
  const close = vi.fn(async () => {});
  ready({ close, decode: vi.fn(), decodeSampled: vi.fn() });
  expect((await Promise.all([a, b])).map(sample => sample.values[0])).toEqual([7, 7]);
  await Promise.all([sampler.close(), sampler.close()]);
  expect(close).toHaveBeenCalledTimes(1);
  await expect(sampler.sample(field(3), Uint32Array.of(0))).rejects.toThrow('closed');
});

it('closes a pool that finishes initializing after cancellation without starting decodes', async () => {
  let ready!: (pool: object) => void;
  mocks.createPool.mockImplementation(() => new Promise(resolve => { ready = resolve; }));
  const sampler = new NoaaFieldSampler();
  const result = sampler.sample(field(40), Uint32Array.of(0));
  const rejected = expect(result).rejects.toThrow('closed');
  const closing = sampler.close(), close = vi.fn(async () => {});
  ready({ close });
  await closing; await rejected;
  expect(close).toHaveBeenCalledTimes(1); expect(mocks.sample).not.toHaveBeenCalled();
});

it('does not return decoded values after cancellation during an asynchronous decode', async () => {
  let finish!: (value: object) => void;
  mocks.sample.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const sampler = new NoaaFieldSampler(), work = sampler.sample(field(3), Uint32Array.of(0));
  const rejected = expect(work).rejects.toThrow('closed');
  await sampler.close(); finish({ values: Float64Array.of(7) });
  await rejected;
  expect(sampler.stats['3']).toMatchObject({ records: 0, failures: 1 });
});
