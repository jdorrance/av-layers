import { afterEach, expect, it, vi } from 'vitest';
import { acquireGfsFrame, createGfsAcquisitionSession } from './acquire.ts';
import * as admission from './admission.ts';
import { gfsCurrentSpecs } from './fields.ts';
import { validAt } from './intervals.ts';
import { compactNoaaSamples, NoaaFieldSampler } from './sampling.ts';
import { NoaaTransport } from './transport.ts';
import type { GfsFrameAcquisition } from './types.ts';

const cycle = '2026-10-30T00:00:00Z';
afterEach(() => vi.restoreAllMocks());

function source() {
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input), hour = Number(/\.f(\d{3})/.exec(url)![1]);
    const product = url.includes('pgrb2b.') ? 'secondary' : 'primary';
    const specs = gfsCurrentSpecs(hour).filter(spec => spec.product === product);
    if (url.endsWith('.idx')) {
      const lines = specs.map((spec, i) => `${i + 1}:${i * 32}:d=2026103000:${spec.variable}:${spec.level}:${spec.forecast}:`);
      lines.push(`${specs.length + 1}:${specs.length * 32}:d=2026103000:DUMMY:surface:unused:`);
      return new Response(lines.join('\n'));
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!;
    const bytes = new Uint8Array(32); bytes[0] = hour; bytes[1] = Number(range[1]) / 32;
    return new Response(bytes, { status: 206, headers: { 'content-range': `bytes ${range[1]}-${range[2]}/100000` } });
  });
  vi.spyOn(admission, 'inspectGfsField').mockImplementation((_bytes, options) => {
    const { spec } = options, instant = spec.statistic === 'instant';
    const interval = instant
      ? { kind: 'instant', start: validAt(cycle, options.expectedEndHour), end: validAt(cycle, options.expectedEndHour) }
      : { kind: 'window', start: validAt(cycle, options.expectedStartHour), end: validAt(cycle, options.expectedEndHour), process: spec.statistic === 'mean' ? 0 : 1, missingCount: 0,
          ranges: [{ process: spec.statistic === 'mean' ? 0 : 1, incrementType: 2, rangeUnit: 1, rangeLength: options.expectedEndHour - options.expectedStartHour, incrementUnit: 255, increment: 0 }] };
    const grid = { kind: 'latlon', gridKey: 'fixture-grid', ni: 1440, nj: 721, longitudeOfFirstGridPoint: 0, latitudeOfFirstGridPoint: 90, iDirectionIncrement: 0.25, jDirectionIncrement: 0.25, earthRadiusM: 6371229, gridDefinitionTemplateNumber: 0 };
    return { grid, packing: 3, packingError: 0, field: {}, receipt: {
      key: spec.key, kind: spec.kind, role: spec.role ?? 'current', variable: spec.variable, level: spec.level, forecastLabel: spec.forecast,
      interval, grid, identification: {}, productMetadata: { typeOfGeneratingProcess: 2 }, unit: spec.statistic === 'mean' ? 'W/m2' : 'kg/m2',
    } } as unknown as admission.InspectedGfsField;
  });
  const sample = vi.spyOn(NoaaFieldSampler.prototype, 'sample').mockImplementation(async (inspected, indices, destination) => {
    const previous = inspected.receipt.interval.end === validAt(cycle, 3);
    const value = inspected.receipt.key === 'precipitation' ? previous ? 99999.999 : 100000 : inspected.receipt.kind === 'sensible-flux' || inspected.receipt.kind === 'latent-flux' ? previous ? 100.0000001 : 150.00000005 : 1.23456789123;
    const values = new Float64Array(indices.length).fill(value);
    const missing = new Uint8Array(indices.length); if (indices.length > 1) missing[1] = 1;
    return compactNoaaSamples(values, missing, indices.length, destination);
  });
  return { fetchImpl, sample };
}
const withoutClock = (frame: GfsFrameAcquisition) => ({ ...frame, capturedAt: '', receipt: { ...frame.receipt, capturedAt: '' } });

it('reuses raw companion precision and immutable inventory/index state with identical frame outputs', async () => {
  const { fetchImpl, sample } = source();
  const options = { cycle, activeIndices: Uint32Array.of(0, 1), fetchImpl };
  const standalone3 = await acquireGfsFrame({ ...options, hour: 3 });
  const standalone6 = await acquireGfsFrame({ ...options, hour: 6 });
  sample.mockClear(); fetchImpl.mockClear();
  const session = await createGfsAcquisitionSession(options);
  try {
    options.activeIndices[0] = 100; // the session owns its validated snapshot
    const frame3 = await session.acquire(3);
    expect(withoutClock(frame3)).toEqual(withoutClock(standalone3));
    frame3.activeIndices[0] = 200;
    const prior = frame3.receipt.fields.find(field => field.key === 'precipitation')!;
    prior.asset.sha256 = 'caller-mutated';
    const frame6 = await session.acquire(6);
    expect(withoutClock(frame6)).toEqual(withoutClock(standalone6));
    expect(frame6.precipitationMmPerHour[0]).toBeCloseTo(0.001 / 3, 9);
    expect(frame6.missing.precipitation).toEqual(Uint8Array.of(0, 1));
    expect(sample).toHaveBeenCalledTimes(100);
    expect(session.stats.rawCompanionHits).toBe(3);
    expect(session.stats.peakPrefetchBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('.idx'))).toHaveLength(4);
    const companion = frame6.receipt.fields.find(field => field.key === 'precipitation' && field.role === 'companion')!;
    expect(companion.asset.sha256).not.toBe('caller-mutated');
  } finally { await session.close(); }
  await expect(session.acquire(9)).rejects.toThrow('closed');
});

it('shares discovery inventories with the acquired cycle', async () => {
  const { fetchImpl } = source();
  const session = await createGfsAcquisitionSession({ activeIndices: Uint32Array.of(0), now: new Date('2026-10-30T08:00:00Z'), fetchImpl });
  try {
    expect(session.cycle).toBe(cycle);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('.idx'))).toHaveLength(16);
    await session.acquire(3);
    expect(fetchImpl.mock.calls.filter(([url]) => String(url).endsWith('.idx'))).toHaveLength(16);
  } finally { await session.close(); }
});

it('coalesces concurrent index loads and preserves stamp validation', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response('1:0:d=2026103000:TMP:850 mb:3 hour fcst:\n2:32:d=2026103000:DUMMY:surface:unused:'));
  const transport = new NoaaTransport({ fetchImpl });
  const [a, b] = await Promise.all([transport.index('https://example.test/a.idx', '2026103000'), transport.index('https://example.test/a.idx', '2026103000')]);
  expect(a).toBe(b); expect(fetchImpl).toHaveBeenCalledTimes(1);
  await expect(transport.index('https://example.test/a.idx', '2026103006')).rejects.toMatchObject({ code: 'source-conflict' });
});

it('closes an in-flight acquisition and refuses concurrent frame calls', async () => {
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));
  const session = await createGfsAcquisitionSession({ cycle, activeIndices: Uint32Array.of(0), fetchImpl });
  const pending = session.acquire(3);
  const rejected = expect(pending).rejects.toThrow('closed');
  await expect(session.acquire(6)).rejects.toThrow('sequentially');
  await session.close(); await rejected;
  expect(fetchImpl).toHaveBeenCalledTimes(2);
});

it('drains a sibling inventory request before returning an initial inventory failure', async () => {
  let abortSeen = false, finish!: () => void, settled = false;
  const cleanup = new Promise<void>(resolve => { finish = resolve; });
  const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
    if (!String(url).includes('pgrb2b.')) return new Response('', { status: 500 });
    return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
      abortSeen = true;
      void cleanup.then(() => reject(init!.signal!.reason));
    }, { once: true }));
  });
  const session = await createGfsAcquisitionSession({ cycle, activeIndices: Uint32Array.of(0), fetchImpl });
  const work = session.acquire(3).catch(error => { settled = true; return error; });
  await vi.waitFor(() => expect(abortSeen).toBe(true));
  expect(settled).toBe(false); finish();
  expect(await work).toMatchObject({ message: expect.stringContaining('HTTP 500') });
  await expect(session.acquire(6)).rejects.toThrow('closed');
  await session.close();
});
