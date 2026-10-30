import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseFields, parseIdx, sampleFieldValuesAsync } from '@azohra/meteo.grib';
import { acquireGfsFrame, contractIndexToNativeIndex } from './acquire.ts';
import * as admission from './admission.ts';
import { inspectGfsField } from './admission.ts';
import { NoaaError } from './errors.ts';
import { gfsCurrentSpecs, gfsPressureSpecs, gfsSurfaceSpecs } from './fields.ts';
import { discoverGfsRun } from './discover.ts';
import {
  gfsWindowStart,
  readNoaaStatisticalInterval,
  recoverTrailingWindow,
} from './intervals.ts';
import { NoaaTransport, selectGfsRecord, selectUniqueRecord, type IndexResult } from './transport.ts';
import { compactNoaaSamples, NoaaFieldSampler } from './sampling.ts';
import { proveGfsInputs } from './prove.ts';

const fixture = (name: string) => readFile(new URL(`./fixtures/${name}`, import.meta.url));

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof NoaaError ? error.code : (error as Error).message;
  }
  return undefined;
}

describe('GFS interval reset and companion differencing', () => {
  it('resets six-hour GFS blocks', () => {
    expect(gfsWindowStart(3)).toBe(0);
    expect(gfsWindowStart(6)).toBe(0);
    expect(gfsWindowStart(9)).toBe(6);
    expect(gfsWindowStart(12)).toBe(6);
    expect(gfsWindowStart(15)).toBe(12);
    expect(gfsWindowStart(24)).toBe(18);
  });

  it('recovers 3-6 h mean 200 from 0-3 = 100 and 0-6 = 150', () => {
    const result = recoverTrailingWindow({
      currentValues: [150],
      companionValues: [100],
      currentHours: 6,
      previousHours: 3,
      statistic: 'mean',
      packingErrorCurrent: 0,
      packingErrorPrevious: 0,
    });
    expect(result.values).toEqual([200]);
    expect(result.derivedHours).toBe(3);
  });

  it('retains a physically negative cooling flux', () => {
    const result = recoverTrailingWindow({
      currentValues: [-80],
      companionValues: [-20],
      currentHours: 6,
      previousHours: 3,
      statistic: 'mean',
      packingErrorCurrent: 0,
      packingErrorPrevious: 0,
    });
    expect(result.values[0]).toBe(-140);
  });

  it('clamps only tiny negative accumulation quantization noise', () => {
    const tiny = recoverTrailingWindow({
      currentValues: [5e-11],
      companionValues: [8e-11],
      currentHours: 6,
      previousHours: 3,
      statistic: 'accumulation',
      packingErrorCurrent: 1e-10,
      packingErrorPrevious: 1e-10,
    });
    expect(tiny.values).toEqual([0]);
    const large = recoverTrailingWindow({
      currentValues: [0.000001],
      companionValues: [0.000002],
      currentHours: 6,
      previousHours: 3,
      statistic: 'accumulation',
      packingErrorCurrent: 1e-10,
      packingErrorPrevious: 1e-10,
    });
    expect(large.values).toEqual([null]);
  });

  it('preserves missing cells independently while differencing', () => {
    const result = recoverTrailingWindow({
      currentValues: [10, null, 8], companionValues: [4, 2, null],
      currentHours: 6, previousHours: 3, statistic: 'accumulation',
      packingErrorCurrent: 0, packingErrorPrevious: 0,
    });
    expect(result.values).toEqual([2, null, null]);
  });

  it('keeps float64 precision and treats the mask as authoritative before differencing', () => {
    const current = compactNoaaSamples([100000, 100000], [0, 1], 2);
    const previous = compactNoaaSamples([99999.999, 2], [0, 0], 2);
    expect(current.values).toBeInstanceOf(Float64Array);
    expect(current.missing).toEqual(Uint8Array.of(0, 1));
    expect(Number.isNaN(current.values[1])).toBe(true);
    const result = recoverTrailingWindow({
      currentValues: current.values, currentMissing: current.missing,
      companionValues: previous.values, companionMissing: previous.missing,
      currentHours: 6, previousHours: 3, statistic: 'accumulation',
      packingErrorCurrent: 0, packingErrorPrevious: 0,
    });
    expect(result.values[0]).toBeCloseTo(0.001 / 3, 9);
    expect(Number.isNaN(result.values[1])).toBe(true);
    expect(result.missing).toEqual(Uint8Array.of(0, 1));
  });

  it('recovers 250000 compact cells without boxed mappings and respects independent masks', () => {
    const count = 250_000;
    const current = new Float64Array(count).fill(150);
    const previous = new Float64Array(count).fill(100);
    const currentMissing = new Uint8Array(count);
    const companionMissing = new Uint8Array(count);
    current[1] = 50;
    currentMissing[1] = 1;
    previous[2] = 50;
    companionMissing[2] = 1;
    current[3] = Number.NaN;
    const arrayFrom = vi.spyOn(Array, 'from');
    const typedMap = vi.spyOn(Float64Array.prototype, 'map');
    let derivedHours = 0;
    try {
      const recovered = recoverTrailingWindow({
        currentValues: current, currentMissing, companionValues: previous, companionMissing,
        currentHours: 6, previousHours: 3, statistic: 'mean', packingErrorCurrent: 0, packingErrorPrevious: 0,
      });
      expect(arrayFrom).not.toHaveBeenCalled();
      expect(typedMap).not.toHaveBeenCalled();
      expect(recovered.values).toBeInstanceOf(Float32Array);
      expect(recovered.missing).toBeInstanceOf(Uint8Array);
      expect(recovered.values.byteLength + recovered.missing.byteLength).toBe(1_250_000);
      expect(recovered.values[0]).toBe(200);
      expect(recovered.missingCount).toBe(3);
      expect(recovered.missing.slice(0, 5)).toEqual(Uint8Array.of(0, 1, 1, 1, 0));
      expect(Number.isNaN(recovered.values[1])).toBe(true);
      derivedHours = recovered.derivedHours;
    } finally {
      arrayFrom.mockRestore();
      typedMap.mockRestore();
    }
    expect(derivedHours).toBe(3);
  });

  it('preserves cooling, quantization and mask behavior on the compact path', () => {
    const base = {
      currentMissing: Uint8Array.of(0, 0, 1, 0), companionMissing: Uint8Array.of(0, 0, 0, 1),
      currentHours: 6, previousHours: 3, packingErrorCurrent: 1e-10, packingErrorPrevious: 1e-10,
    };
    const flux = recoverTrailingWindow({ ...base, currentValues: Float64Array.of(-80, -80, 22, 22), companionValues: Float64Array.of(-20, -20, 1, 1), statistic: 'mean' });
    expect(flux.values[0]).toBe(-140);
    expect(flux.missing).toEqual(Uint8Array.of(0, 0, 1, 1));
    const rain = recoverTrailingWindow({ ...base, currentValues: Float64Array.of(5e-11, 1e-6, 100, 100), companionValues: Float64Array.of(8e-11, 2e-6, 1, 1), statistic: 'accumulation' });
    expect(rain.values[0]).toBe(0);
    expect(rain.missing).toEqual(Uint8Array.of(0, 1, 1, 1));
    expect(rain.missingCount).toBe(3);
    expect(() => recoverTrailingWindow({ ...base, currentMissing: Uint8Array.of(0), currentValues: Float64Array.of(1, 2, 3, 4), companionValues: Float64Array.of(1, 2, 3, 4), statistic: 'mean' })).toThrow(/mask/);
  });

  it('handles direct three-hour compact windows without a companion', () => {
    const base = {
      currentValues: Float64Array.of(-20, 9, 5), currentMissing: Uint8Array.of(0, 1, 0),
      companionValues: null, companionMissing: null, currentHours: 3, previousHours: 0,
      packingErrorCurrent: 0, packingErrorPrevious: 0,
    };
    const flux = recoverTrailingWindow({ ...base, statistic: 'mean' });
    expect(flux.values[0]).toBe(-20);
    expect(flux.missing).toEqual(Uint8Array.of(0, 1, 0));
    const rain = recoverTrailingWindow({ ...base, statistic: 'accumulation' });
    expect(rain.missing).toEqual(Uint8Array.of(1, 1, 0));
    expect(rain.values[2]).toBeCloseTo(5 / 3);
  });

  it('marks Float32 overflow missing without changing finite boundaries or legacy numbers', () => {
    const maxFloat32 = (2 - 2 ** -23) * 2 ** 127;
    const values = [1e39, -1e39, maxFloat32, -maxFloat32, 7, -0, 0];
    const base = { companionValues: null, currentHours: 3, previousHours: 0, statistic: 'mean' as const, packingErrorCurrent: 0, packingErrorPrevious: 0 };
    const compact = recoverTrailingWindow({
      ...base, currentValues: Float64Array.from(values), currentMissing: Uint8Array.of(0, 0, 0, 0, 1, 0, 0), companionMissing: null,
    });
    expect(compact.missing).toEqual(Uint8Array.of(1, 1, 0, 0, 1, 0, 0));
    expect(compact.missingCount).toBe(3);
    expect(Number.isNaN(compact.values[0])).toBe(true);
    expect(Number.isNaN(compact.values[1])).toBe(true);
    expect(compact.values[2]).toBe(maxFloat32);
    expect(compact.values[3]).toBe(-maxFloat32);
    expect(Object.is(compact.values[5], -0)).toBe(true);
    expect(compact.values[6]).toBe(0);
    const legacy = recoverTrailingWindow({ ...base, currentValues: values });
    expect(legacy.values[0]).toBe(1e39);
    expect(legacy.values[1]).toBe(-1e39);
    const rain = recoverTrailingWindow({
      ...base, statistic: 'accumulation', currentValues: Float64Array.of(3e39), currentMissing: Uint8Array.of(0), companionMissing: null,
    });
    expect(rain.missing).toEqual(Uint8Array.of(1));
    expect(Number.isNaN(rain.values[0])).toBe(true);
  });

  it('propagates finite masked and non-finite values without an external fixture', () => {
    const sampled = compactNoaaSamples([10, 42, Number.NaN], [0, 1, 0], 3);
    expect(sampled.missing).toEqual(Uint8Array.of(0, 1, 1));
    expect(sampled.values[0]).toBe(10);
    expect(Number.isNaN(sampled.values[1])).toBe(true);
    expect(Number.isNaN(sampled.values[2])).toBe(true);
    expect(sampled.missingCount).toBe(2);
    expect(() => compactNoaaSamples([1, 2], [0], 2)).toThrow(/mask count/);
  });
});

describe('diagnostic proof and transport accounting', () => {
  function inventoryFetch(mode: 'complete' | 'unbounded' | 'missing-secondary' | 'duplicates' | 'conflict-3' | 'conflict-6'): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      if (!url.endsWith('.idx')) {
        const hour = Number(/\.f(\d{3})$/.exec(url)?.[1]);
        const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range') ?? '')!;
        const start = Number(range[1]);
        const end = Number(range[2]);
        const specs = gfsCurrentSpecs(hour).filter((spec) => spec.product === 'primary');
        const duplicatePosition = specs.findIndex((spec) => spec.key === 'precipitation') + 1;
        const bytes = Buffer.alloc(24);
        bytes.write('GRIB');
        bytes[7] = 2;
        bytes.writeBigUInt64BE(24n, 8);
        bytes.write('7777', 20);
        if (mode === `conflict-${hour}` && start / 24 === duplicatePosition) bytes[16] = 1;
        return new Response(Uint8Array.from(bytes), { status: 206, headers: { 'content-range': `bytes ${start}-${end}/100000` } });
      }
      const match = /gfs\.(\d{8})\/(\d{2})\/atmos\/gfs\.t\d{2}z\.(pgrb2b?\.0p25)\.f(\d{3})\.idx/.exec(String(input));
      if (!match) throw new Error(`Unexpected inventory URL ${String(input)}`);
      const [, date, cycleHour, productName, hourText] = match;
      const hour = Number(hourText);
      const product = productName === 'pgrb2b.0p25' ? 'secondary' : 'primary';
      const stamp = `${date}${cycleHour}`;
      let specs = gfsCurrentSpecs(hour).filter((spec) => spec.product === product);
      if (mode === 'missing-secondary' && hour === 24 && product === 'secondary') {
        specs = specs.filter((spec) => spec.key !== '625.tmp');
      }
      const duplicateMode = mode === 'duplicates' || mode === 'conflict-3' || mode === 'conflict-6';
      if (duplicateMode && product === 'primary' && (hour === 3 || hour === 6)) {
        const i = specs.findIndex((spec) => spec.key === 'precipitation');
        specs.splice(i, 0, specs[i]!);
      }
      const spacing = duplicateMode ? 24 : 100;
      const lines = specs.map((spec, i) => `${i + 1}:${i * spacing}:d=${stamp}:${spec.variable}:${spec.level}:${spec.forecast}:`);
      if (!(mode === 'unbounded' && hour === 3 && product === 'primary')) {
        lines.push(`${lines.length + 1}:${lines.length * spacing}:d=${stamp}:DUMMY:surface:unused:`);
      }
      return new Response(lines.join('\n'));
    };
  }

  it('labels complete inventories as decoded admission not checked', async () => {
    const result = await discoverGfsRun({ now: new Date('2026-10-30T08:00:00Z'), fetchImpl: inventoryFetch('complete') });
    expect(result).toMatchObject({ cycle: '2026-10-30T00:00:00Z', inventoryComplete: true, decodedAdmission: 'not-checked', availableHours: [3, 6, 9, 12, 15, 18, 21, 24] });
  });

  it('rejects candidate runs with an unbounded required record or a missing secondary level', async () => {
    for (const mode of ['unbounded', 'missing-secondary'] as const) {
      try {
        await discoverGfsRun({ now: new Date('2026-10-30T08:00:00Z'), fetchImpl: inventoryFetch(mode) });
        throw new Error('Expected discovery to reject incomplete inventory');
      } catch (error) {
        expect(error).toBeInstanceOf(NoaaError);
        const refusal = error as NoaaError;
        expect(refusal.code).toBe('run-unavailable');
        expect(refusal.details?.failures).toHaveLength(6);
        expect(JSON.stringify(refusal.details?.failures)).toContain(mode === 'unbounded' ? 'unsupported byte range' : '625.tmp');
      }
    }
  });

  it('verifies duplicate bytes before discovery reports inventory completeness', async () => {
    const options = { now: new Date('2026-10-30T08:00:00Z') };
    const result = await discoverGfsRun({ ...options, fetchImpl: inventoryFetch('duplicates') });
    expect(result).toMatchObject({ inventoryComplete: true, decodedAdmission: 'not-checked' });
    expect(result.duplicates.some((item) => item.key === 'precipitation' && item.role === 'current')).toBe(true);
    expect(result.duplicates.some((item) => item.key === 'precipitation' && item.role === 'companion')).toBe(true);
    for (const mode of ['conflict-3', 'conflict-6'] as const) {
      await expect(discoverGfsRun({ ...options, fetchImpl: inventoryFetch(mode) })).rejects.toMatchObject({ code: 'run-unavailable' });
    }
  });

  it('throws from acquisition for conflicts in either current or predecessor precipitation', async () => {
    vi.spyOn(admission, 'inspectGfsField').mockImplementation((_bytes, options) => {
      const interval = options.spec.statistic === 'instant'
        ? { kind: 'instant', start: '2026-10-30T06:00:00Z', end: '2026-10-30T06:00:00Z' }
        : { kind: 'window', start: '2026-10-30T00:00:00Z', end: `2026-10-30T0${options.expectedEndHour}:00:00Z`, process: 0, missingCount: 0,
            ranges: [{ process: 0, incrementType: 2, rangeUnit: 1, rangeLength: options.expectedEndHour, incrementUnit: 255, increment: 0 }] };
      const grid = { kind: 'latlon', gridKey: 'test' };
      return { grid, packingError: 0, receipt: { ...options.spec, grid, interval, unit: 'test', identification: {}, productMetadata: { typeOfGeneratingProcess: 2 } } } as unknown as ReturnType<typeof admission.inspectGfsField>;
    });
    vi.spyOn(NoaaFieldSampler.prototype, 'sample').mockResolvedValue({ values: Float64Array.of(1), missing: Uint8Array.of(0), missingCount: 0 });
    try {
      for (const mode of ['conflict-3', 'conflict-6'] as const) {
        await expect(acquireGfsFrame({ cycle: '2026-10-30T00:00:00Z', hour: 6, activeIndices: Uint32Array.of(0), fetchImpl: inventoryFetch(mode) })).rejects.toMatchObject({ code: 'record-ambiguous' });
      }
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('counts HTTP, persistent cache and in-memory index reads separately', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noaa-test-'));
    const text = '1:0:d=2026081118:TMP:850 mb:6 hour fcst:\n2:10:d=2026081118:HGT:850 mb:6 hour fcst:\n';
    let calls = 0;
    const fetchImpl: typeof fetch = async () => { calls++; return new Response(text); };
    try {
      const first = new NoaaTransport({ cacheDir: dir, fetchImpl });
      await first.index('https://example.test/a.idx', '2026081118');
      await first.index('https://example.test/a.idx', '2026081118');
      expect(first.stats).toEqual({ networkRequests: 1, cacheReads: 0, memoryIndexHits: 1 });
      const second = new NoaaTransport({ cacheDir: dir, fetchImpl });
      await second.index('https://example.test/a.idx', '2026081118');
      expect(second.stats).toEqual({ networkRequests: 0, cacheReads: 1, memoryIndexHits: 0 });
      expect(calls).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('continues after duplicate precipitation and reports later admitted fields without publication', async () => {
    const bytes = await fixture('gfs-tmp-850mb.grib2');
    const text = [
      '1:0:d=2026081118:TMP:850 mb:6 hour fcst:',
      `2:${bytes.length}:d=2026081118:APCP:surface:0-6 hour acc fcst:`,
      `3:${bytes.length + 10}:d=2026081118:APCP:surface:0-6 hour acc fcst:`,
      `4:${bytes.length + 20}:d=2026081118:HGT:other:6 hour fcst:`,
    ].join('\n');
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).endsWith('.idx')) return new Response(text);
      return new Response(bytes, { status: 206, headers: { 'content-range': `bytes 0-${bytes.length - 1}/${bytes.length + 100}` } });
    };
    const report = await proveGfsInputs({ diagnostic: true, cycle: '2026-08-11T18:00:00Z', hour: 6, activeIndices: Uint32Array.of(0), fetchImpl, logger: () => {} });
    expect(report.ok).toBe(false);
    expect(report.publicationEligible).toBe(false);
    expect(report.fields.find((f) => f.spec.key === 'precipitation' && f.spec.role === 'current')).toMatchObject({ status: 'failed', error: { code: 'transport' } });
    expect(report.fields.find((f) => f.spec.key === '850.tmp')).toMatchObject({ status: 'admitted', missing: [0] });
    expect(report.fields).toHaveLength(53);
    expect(report.transport.networkRequests).toBe(5);
  });
});

describe('bounded NOAA field transport', () => {
  const record = parseIdx('1:0:d=2026103000:TMP:surface:6 hour fcst:\n2:10:d=2026103000:HGT:surface:6 hour fcst:')[0]!;
  const url = 'https://example.test/field';

  function streamingFetch(chunks: number[], onCancel: () => void): typeof fetch {
    return async () => {
      let index = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index === chunks.length) controller.close();
          else controller.enqueue(new Uint8Array(chunks[index++]!).fill(7));
        },
        cancel: onCancel,
      });
      return new Response(stream, { status: 206, headers: { 'content-range': 'bytes 0-9/20', 'content-length': '10' } });
    };
  }

  it('cancels an oversized stream even when Content-Length claims the expected size', async () => {
    let canceled = false;
    const transport = new NoaaTransport({ fetchImpl: streamingFetch([5, 6, 1_000], () => { canceled = true; }) });
    await expect(transport.field(url, record)).rejects.toMatchObject({ code: 'transport', message: expect.stringContaining('Oversized') });
    expect(canceled).toBe(true);
  });

  it('rejects a short stream and accepts exact chunked bytes', async () => {
    await expect(new NoaaTransport({ fetchImpl: streamingFetch([4, 5], () => {}) }).field(url, record)).rejects.toMatchObject({ code: 'transport', message: expect.stringContaining('Truncated') });
    const result = await new NoaaTransport({ fetchImpl: streamingFetch([4, 6], () => {}) }).field(url, record);
    expect(result.bytes).toEqual(Buffer.alloc(10, 7));
  });

  it('rejects an oversized cache file before accepting its receipt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'noaa-field-cache-'));
    try {
      const first = new NoaaTransport({ cacheDir: dir, fetchImpl: streamingFetch([10], () => {}) });
      const result = await first.field(url, record);
      await appendFile(join(dir, result.asset.file!), Buffer.alloc(1));
      const second = new NoaaTransport({ cacheDir: dir, fetchImpl: async () => { throw new Error('unexpected fetch'); } });
      await expect(second.field(url, record)).rejects.toMatchObject({ code: 'transport', message: expect.stringContaining('cache file size') });
      expect(second.stats).toMatchObject({ cacheReads: 0, networkRequests: 0 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('verified GFS duplicate selection', () => {
  const spec = { key: 'precipitation', variable: 'APCP', level: 'surface', forecast: '0-6 hour acc fcst' };
  const message = () => {
    const bytes = Buffer.alloc(24);
    bytes.write('GRIB', 0);
    bytes[7] = 2;
    bytes.writeBigUInt64BE(BigInt(bytes.length), 8);
    bytes.write('7777', bytes.length - 4);
    return bytes;
  };
  const indexFor = (count: number, length = 24, sentinel = true): IndexResult => {
    const lines = Array.from({ length: count }, (_, i) => `${i + 1}:${i * length}:d=2026103000:APCP:surface:0-6 hour acc fcst:`);
    if (sentinel) lines.push(`${count + 1}:${count * length}:d=2026103000:DUMMY:surface:other:`);
    const text = lines.join('\n');
    return { text, records: parseIdx(text), asset: { url: 'https://example.test/a.idx', range: null, sha256: '', size: text.length, file: null } };
  };
  const fetchMessages = (messages: Buffer[], mode?: 'truncated' | 'range' | 'status'): typeof fetch => async (_input, init) => {
    const range = new Headers(init?.headers).get('range')!;
    const parts = /^bytes=(\d+)-(\d+)$/.exec(range)!;
    const start = Number(parts[1]);
    const end = Number(parts[2]);
    const bytes = messages[start / 24]!;
    return new Response(Uint8Array.from(mode === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes), {
      status: mode === 'status' ? 200 : 206,
      headers: { 'content-range': mode === 'range' ? 'bytes 0-23/*' : `bytes ${start}-${end}/${messages.length * 24}` },
    });
  };

  it('accepts only byte-identical complete messages and records sorted provenance', async () => {
    const index = indexFor(2);
    index.records.reverse();
    const a = message();
    const result = await selectGfsRecord(new NoaaTransport({ fetchImpl: fetchMessages([a, a]) }), 'https://example.test/a', index, spec);
    expect(result.selected.record.offset).toBe(0);
    expect(result.duplicates).toMatchObject({ rule: 'full-grib-byte-identical-v1', selectedOffset: 0, candidates: [{ offset: 0, length: 24 }, { offset: 24, length: 24 }] });
    expect(result.duplicates!.candidates[0]!.asset.sha256).toBe(result.duplicates!.candidates[1]!.asset.sha256);
    expect(result.duplicates!.candidates.map((c) => c.idxLineNumber)).toEqual([1, 2]);
  });

  it('preserves unique selection without fetching and rejects strict duplicates', async () => {
    const fetchImpl: typeof fetch = async () => { throw new Error('unexpected fetch'); };
    const transport = new NoaaTransport({ fetchImpl });
    const index = indexFor(1);
    expect((await selectGfsRecord(transport, 'https://example.test/a', index, spec)).selected.record.offset).toBe(0);
    expect(transport.stats.networkRequests).toBe(0);
    const duplicate = indexFor(2);
    expect(() => selectUniqueRecord(duplicate.records, duplicate.text, spec)).toThrow(/Ambiguous/);
  });

  it('refuses different packing encodings of numerically identical fields', async () => {
    const source = await fixture('gfs-tmp-850mb.grib2');
    let offset = 16;
    const sections = new Map<number, number>();
    while (offset < source.length - 4) {
      sections.set(source[offset + 4]!, offset);
      offset += source.readUInt32BE(offset);
    }
    const s5 = sections.get(5)!;
    const s7 = sections.get(7)!;
    const encoded = (reference: number, binaryScale: number) => {
      const section5 = Buffer.alloc(21);
      section5.writeUInt32BE(21, 0);
      section5[4] = 5;
      section5.writeUInt32BE(source.readUInt32BE(s5 + 5), 5);
      section5.writeFloatBE(reference, 11);
      section5.writeUInt16BE(binaryScale, 15);
      const bytes = Buffer.concat([source.subarray(0, s5), section5,
        source.subarray(s5 + source.readUInt32BE(s5), s7), Buffer.from([0, 0, 0, 5, 7]), Buffer.from('7777')]);
      bytes.writeBigUInt64BE(BigInt(bytes.length), 8);
      return bytes;
    };
    const a = encoded(10, 0);
    const b = encoded(10, 1);
    const original = await sampleFieldValuesAsync(parseFields(a)[0]!, [0, 500_000]);
    const changed = await sampleFieldValuesAsync(parseFields(b)[0]!, [0, 500_000]);
    expect(Array.from(original.values)).toEqual([10, 10]);
    expect(changed.values).toEqual(original.values);
    const fetchImpl: typeof fetch = async (_input, init) => {
      const start = Number(/^bytes=(\d+)-/.exec(new Headers(init?.headers).get('range')!)![1]);
      const bytes = start === 0 ? a : b;
      return new Response(Uint8Array.from(bytes), { status: 206, headers: { 'content-range': `bytes ${start}-${start + bytes.length - 1}/${a.length * 2}` } });
    };
    await expect(selectGfsRecord(new NoaaTransport({ fetchImpl }), 'https://example.test/a', indexFor(2, a.length), spec)).rejects.toMatchObject({ code: 'record-ambiguous' });
  });

  it('rejects conflicting lengths, unbounded records, and excessive duplicates before fetching', async () => {
    const transport = new NoaaTransport({ fetchImpl: async () => { throw new Error('unexpected fetch'); } });
    const unequal = indexFor(2);
    unequal.records[1]!.length = 25;
    await expect(selectGfsRecord(transport, 'https://example.test/a', unequal, spec)).rejects.toMatchObject({ code: 'record-ambiguous' });
    await expect(selectGfsRecord(transport, 'https://example.test/a', indexFor(2, 24, false), spec)).rejects.toMatchObject({ code: 'record-missing' });
    await expect(selectGfsRecord(transport, 'https://example.test/a', indexFor(9), spec)).rejects.toMatchObject({ code: 'record-ambiguous' });
    await expect(selectGfsRecord(transport, 'https://example.test/a', indexFor(2, 32 * 1024 * 1024 + 1), spec)).rejects.toMatchObject({ code: 'record-ambiguous' });
    expect(transport.stats.networkRequests).toBe(0);
  });

  it('rejects bad range status, Content-Range, truncated body, and invalid GRIB envelopes', async () => {
    const a = message();
    for (const mode of ['status', 'range', 'truncated'] as const) {
      await expect(selectGfsRecord(new NoaaTransport({ fetchImpl: fetchMessages([a, a], mode) }), 'https://example.test/a', indexFor(2), spec)).rejects.toMatchObject({ code: 'transport' });
    }
    for (const mutate of [(b: Buffer) => { b[0] = 0; }, (b: Buffer) => { b.writeBigUInt64BE(23n, 8); }, (b: Buffer) => { b[23] = 0; }]) {
      const invalid = Buffer.from(a);
      mutate(invalid);
      await expect(selectGfsRecord(new NoaaTransport({ fetchImpl: fetchMessages([invalid, invalid]) }), 'https://example.test/a', indexFor(2), spec)).rejects.toMatchObject({ code: 'source-conflict' });
    }
  });

  it('reports conflicting current and companion records independently', async () => {
    const a = message();
    const b = Buffer.from(a);
    b[16] = 1;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith('.idx')) {
        const forecast = url.includes('.f003.') ? '0-3 hour acc fcst' : '0-6 hour acc fcst';
        return new Response(`1:0:d=2026103000:APCP:surface:${forecast}:\n2:24:d=2026103000:APCP:surface:${forecast}:\n3:48:d=2026103000:DUMMY:surface:other:`);
      }
      return fetchMessages([a, b])(input, init);
    };
    const report = await proveGfsInputs({ diagnostic: true, cycle: '2026-10-30T00:00:00.000Z', hour: 6, activeIndices: Uint32Array.of(0), fetchImpl, logger: () => {} });
    const precip = report.fields.filter((field) => field.spec.key === 'precipitation');
    expect(precip).toHaveLength(2);
    expect(precip.map((field) => field.status === 'failed' && field.error.code)).toEqual(['record-ambiguous', 'record-ambiguous']);
  });
});

describe('GFS idx and PDT admission', () => {
  it('rejects the unbounded last record while accepting its bounded predecessor', () => {
    const text = [
      '1:0:d=2026080612:TMP:850 mb:6 hour fcst:',
      '2:100:d=2026080612:HGT:850 mb:6 hour fcst:',
    ].join('\n');
    const records = parseIdx(text);
    const spec = { key: '850.tmp', variable: 'TMP', level: '850 mb', forecast: '6 hour fcst' };
    expect(selectUniqueRecord(records, text, spec).record.length).toBe(100);
    expect(() => selectUniqueRecord(records, text, { ...spec, key: '850.hgt', variable: 'HGT' })).toThrow(/unsupported byte range/);
  });

  it('rejects duplicate idx identities instead of skipping them', () => {
    const text = [
      '1:0:d=2026080612:APCP:surface:0-3 hour acc fcst:',
      '2:100:d=2026080612:APCP:surface:0-3 hour acc fcst:',
    ].join('\n');
    const records = parseIdx(text);
    expect(() =>
      selectUniqueRecord(records, text, {
        key: 'precipitation',
        variable: 'APCP',
        level: 'surface',
        forecast: '0-3 hour acc fcst',
      }),
    ).toThrow(/Ambiguous/);
  });

  it('rejects a discrete PDT 4.8 increment', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const field = parseFields(bytes)[0]!;
    const section4 = Uint8Array.from(field.section4);
    new DataView(section4.buffer).setUint32(54, 1);
    expect(() => readNoaaStatisticalInterval(section4, field.identification)).toThrow(/continuous increment 0/);
  });

  it('admits the real continuous 0-6 h ecCodes fixture', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const field = parseFields(bytes)[0]!;
    const interval = readNoaaStatisticalInterval(field.section4, field.identification);
    expect(interval).toMatchObject({
      kind: 'window',
      start: '2026-08-11T18:00:00.000Z',
      end: '2026-08-12T00:00:00.000Z',
      process: 0,
    });
    if (interval.kind === 'window') expect(interval.ranges[0]!.increment).toBe(0);
  });

  it('refuses unsupported GFS packing explicitly', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const field = parseFields(bytes)[0]!;
    const copy = Buffer.from(bytes);
    const section5Offset = field.section5.byteOffset - bytes.byteOffset;
    new DataView(copy.buffer, copy.byteOffset, copy.byteLength).setUint16(section5Offset + 9, 41);
    const spec = gfsSurfaceSpecs(6).find((candidate) => candidate.kind === 'sensible-flux')!;
    expect(
      codeOf(() =>
        inspectGfsField(copy, {
          cycle: '2026-08-11T18:00:00Z',
          spec,
          expectedStartHour: 0,
          expectedEndHour: 6,
        }),
      ),
    ).toBe('unsupported-packing');
  });
});

describe('GFS decoded field receipt and sampling', () => {
  it('rejects affected decimal-scaled constants for all supported packing templates with metadata', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const original = parseFields(bytes)[0]!;
    const section5Offset = original.section5.byteOffset - bytes.byteOffset;
    const spec = gfsSurfaceSpecs(6).find((candidate) => candidate.kind === 'sensible-flux')!;
    const options = { cycle: '2026-08-11T18:00:00Z', spec, expectedStartHour: 0, expectedEndHour: 6 };
    for (const packing of [0, 2, 3, 40]) {
      for (const decimal of [1, -1]) {
        const copy = Buffer.from(bytes);
        const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
        view.setUint16(section5Offset + 9, packing);
        view.setFloat32(section5Offset + 11, 100);
        view.setUint16(section5Offset + 17, decimal < 0 ? 0x8001 : 1);
        view.setUint8(section5Offset + 19, 0);
        if (packing === 2 || packing === 3) view.setUint32(section5Offset + 31, 0);
        expect(100 * 10 ** -decimal).toBe(decimal === 1 ? 10 : 1000);
        try {
          inspectGfsField(copy, options);
          throw new Error('Expected unsupported packing');
        } catch (error) {
          expect(error).toMatchObject({ code: 'unsupported-packing', details: { packing, decimalScaleFactor: decimal, referenceValue: 100, bitsPerValue: 0, numberOfGroups: packing === 2 || packing === 3 ? 0 : null, encodingSha256: expect.stringMatching(/^[a-f0-9]{64}$/) } });
        }
        view.setUint16(section5Offset + 17, 0);
        expect(inspectGfsField(copy, options).receipt.packing).toBe(packing);
        view.setUint16(section5Offset + 17, decimal < 0 ? 0x8001 : 1);
        if (packing === 2 || packing === 3) view.setUint32(section5Offset + 31, 1);
        else view.setUint8(section5Offset + 19, 8);
        expect(inspectGfsField(copy, options).receipt.packing).toBe(packing);
      }
    }
  });

  it('routes all 21 height and temperature levels to their correct products', () => {
    const specs = gfsPressureSpecs(6);
    expect(specs).toHaveLength(42);
    expect(specs.filter((spec) => spec.product === 'secondary').map((spec) => spec.key)).toEqual(
      [875, 825, 775, 725, 675, 625].flatMap((level) => [`${level}.hgt`, `${level}.tmp`]),
    );
  });

  it('admits the ecCodes instantaneous 850 mb temperature and rejects wrong time', async () => {
    const bytes = await fixture('gfs-tmp-850mb.grib2');
    const spec = gfsPressureSpecs(6).find((candidate) => candidate.key === '850.tmp')!;
    const inspected = inspectGfsField(bytes, {
      cycle: '2026-08-11T18:00:00Z', spec, expectedStartHour: 6, expectedEndHour: 6,
    });
    expect(inspected.interval).toMatchObject({ kind: 'instant', start: '2026-08-12T00:00:00.000Z' });
    expect(() => inspectGfsField(bytes, {
      cycle: '2026-08-11T18:00:00Z', spec, expectedStartHour: 3, expectedEndHour: 3,
    })).toThrow(/Wrong GFS instant valid time/);
  });

  it('validates full identity, grid, product and statistical metadata on an ecCodes fixture', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const spec = gfsSurfaceSpecs(6).find((candidate) => candidate.kind === 'sensible-flux')!;
    const inspected = inspectGfsField(bytes, {
      cycle: '2026-08-11T18:00:00Z',
      spec,
      expectedStartHour: 0,
      expectedEndHour: 6,
    });
    expect(inspected.grid.gridKey).toBe('82e6ec43e0df1933');
    expect(inspected.receipt.identification.centre).toBe(7);
    expect(inspected.receipt.productMetadata).toMatchObject({
      productDefinitionTemplateNumber: 8,
      parameterCategory: 0,
      parameterNumber: 11,
      typeOfGeneratingProcess: 2,
    });
    expect(inspected.receipt.interval).toMatchObject({
      kind: 'window',
      process: 0,
      start: '2026-08-11T18:00:00.000Z',
      end: '2026-08-12T00:00:00.000Z',
    });
    expect(inspected.receipt.packing).toBe(3);
    expect(inspected.receipt.packingError).toBeCloseTo(0.05);
    expect(() => inspectGfsField(bytes, {
      cycle: '2026-08-11T18:00:00Z', spec, expectedStartHour: 3, expectedEndHour: 6,
    })).toThrow(/Wrong GFS statistical window/);
  });

  it('decodes GRIB sign-magnitude packing scales', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const field = parseFields(bytes)[0]!;
    const copy = Buffer.from(bytes);
    const section5Offset = field.section5.byteOffset - bytes.byteOffset;
    const view = new DataView(copy.buffer, copy.byteOffset, copy.byteLength);
    view.setUint16(section5Offset + 15, 0x8002);
    view.setUint16(section5Offset + 17, 0x8001);
    const spec = gfsSurfaceSpecs(6).find((candidate) => candidate.kind === 'sensible-flux')!;
    const inspected = inspectGfsField(copy, {
      cycle: '2026-08-11T18:00:00Z', spec, expectedStartHour: 0, expectedEndHour: 6,
    });
    expect(inspected.packingError).toBe(1.25);
  });

  it('samples active native indexes through the public decoder API', async () => {
    const bytes = await fixture('gfs-shtfl-ave-0-6h.grib2');
    const field = parseFields(bytes)[0]!;
    const sampled = await sampleFieldValuesAsync(field, [0, 500_000, 1_038_239]);
    expect(sampled.values).toHaveLength(3);
    for (const value of sampled.values) expect(Number.isFinite(value)).toBe(true);
    expect(sampled.missingMask).toBeUndefined();
  });

  it('maps contract lon0=-180 indexes to native lon0=0 storage', () => {
    expect(contractIndexToNativeIndex(0)).toBe(720);
    expect(contractIndexToNativeIndex(720)).toBe(0);
    expect(contractIndexToNativeIndex(1439)).toBe(719);
    expect(contractIndexToNativeIndex(1440 * 200 + 300)).toBe(1440 * 200 + 1020);
  });
});
