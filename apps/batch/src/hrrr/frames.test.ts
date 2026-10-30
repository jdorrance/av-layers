import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { activeFieldValues, discoverHrrrRun, precipitationRate } from './acquire.ts';
import { hrrrFrameIntervals, hrrrInstantForecastLabel, hrrrPrecipitationForecastLabel } from './fields.ts';

const fixtureText = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const bounded = (text: string) => {
  const lines = text.trim().split('\n');
  const [number, offset] = lines[lines.length - 1]!.split(':').map(Number);
  return `${text.trim()}\n${number! + 1}:${offset! + 1_000_000}:d=2026103006:TEST:surface:1 hour fcst:\n`;
};

function fixtureFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('hrrr.t06z.wrfsfcf01.grib2.idx')) return new Response(bounded(fixtureText('hrrr.t06z.wrfsfcf01.excerpt.idx')), { status: 200 });
    if (url.endsWith('hrrr.t06z.wrfprsf01.grib2.idx')) return new Response(bounded(fixtureText('hrrr.t06z.wrfprsf01.excerpt.idx')), { status: 200 });
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

describe('HRRR discovery and source-supported times', () => {
  it('discovers the live 06Z run from actual index inventories', async () => {
    const run = await discoverHrrrRun({
      now: new Date('2026-10-30T07:49:26Z'),
      requiredHours: [1],
      fetchImpl: fixtureFetch(),
    });
    expect(run.cycle).toBe('2026-10-30T06:00:00Z');
    expect(run.products).toEqual({ surface: 'wrfsfc', pressure: 'wrfprs' });
    expect(run.availableHours).toEqual([1]);
    expect(run.inventory.pressureLevelsHpa).toHaveLength(25);
    expect(run.inventory.pressureLevelsHpa[0]).toBe(1000);
    expect(run.inventory.pressureLevelsHpa[24]).toBe(400);
    expect(run.inventory.precipitationForecast).toBe('0-1 hour acc fcst');
    expect(run.inventory.fluxStatistic).toBe('instant');
    expect(run.inventory.humidityRepresentation).toBe('dewpoint-2m');
    expect(run.status).toBe('inventory-only');
    expect(run.inventories.map((entry) => entry.hour)).toEqual([1]);
  });

  it('fails when a dense pressure identity is absent instead of inventing it', async () => {
    const pressure = fixtureText('hrrr.t06z.wrfprsf01.excerpt.idx')
      .split('\n')
      .filter((line) => !line.includes(':HGT:425 mb:'))
      .join('\n');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('hrrr.t06z.wrfsfcf01.grib2.idx')) return new Response(bounded(fixtureText('hrrr.t06z.wrfsfcf01.excerpt.idx')), { status: 200 });
      if (url.endsWith('hrrr.t06z.wrfprsf01.grib2.idx')) return new Response(bounded(pressure), { status: 200 });
      return new Response('', { status: 404 });
    }) as typeof fetch;
    await expect(discoverHrrrRun({ cycle: '2026-10-30T06:00:00Z', requiredHours: [1], fetchImpl })).rejects.toThrow(/Missing required NOAA record/);
  });

  it('admits every requested inventory, not just the first or a successful HEAD', async () => {
    const surface1 = fixtureText('hrrr.t06z.wrfsfcf01.excerpt.idx');
    const pressure1 = fixtureText('hrrr.t06z.wrfprsf01.excerpt.idx');
    const surface2 = fixtureText('hrrr.t06z.wrfsfcf02.excerpt.idx');
    const pressure2 = pressure1.replaceAll('1 hour fcst', '2 hour fcst');
    let incomplete = false;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'HEAD') return new Response(null, { status: 200 });
      if (url.endsWith('wrfsfcf01.grib2.idx')) return new Response(bounded(surface1));
      if (url.endsWith('wrfprsf01.grib2.idx')) return new Response(bounded(pressure1));
      if (url.endsWith('wrfsfcf02.grib2.idx')) return new Response(bounded(surface2));
      if (url.endsWith('wrfprsf02.grib2.idx')) return new Response(bounded(incomplete ? pressure2.split('\n').filter((line) => !line.includes(':HGT:425 mb:')).join('\n') : pressure2));
      return new Response('', { status: 404 });
    }) as typeof fetch;
    const options = { cycle: '2026-10-30T06:00:00Z', requiredHours: [1, 2], fetchImpl };
    const run = await discoverHrrrRun(options);
    expect(run.availableHours).toEqual([1, 2]);
    expect(run.inventories.map((entry) => entry.hour)).toEqual([1, 2]);
    incomplete = true;
    await expect(discoverHrrrRun(options)).rejects.toThrow(/Missing required NOAA record/);
    const partial = await discoverHrrrRun({ ...options, requiredHours: [1], maxHour: 2 });
    expect(partial.availableHours).toEqual([1]);
  });

  it('uses exact source-specific labels and a one-hour trailing rain interval', () => {
    expect(hrrrInstantForecastLabel(0)).toBe('anl');
    expect(hrrrInstantForecastLabel(1)).toBe('1 hour fcst');
    expect(hrrrPrecipitationForecastLabel(1)).toBe('0-1 hour acc fcst');
    expect(hrrrPrecipitationForecastLabel(2)).toBe('1-2 hour acc fcst');
    expect(hrrrPrecipitationForecastLabel(24)).toBe('23-24 hour acc fcst');
    expect(hrrrFrameIntervals('2026-10-30T06:00:00Z', 2)).toEqual({
      profileTime: '2026-10-30T08:00:00Z',
      flux: { kind: 'instant', validAt: '2026-10-30T08:00:00Z' },
      precipitation: {
        kind: 'window',
        start: '2026-10-30T07:00:00Z',
        end: '2026-10-30T08:00:00Z',
        durationHours: 1,
        sourceLabel: '1-2 hour acc fcst',
      },
    });
  });
});

describe('HRRR per-cell missingness', () => {
  it('preserves source missing bits and NaNs without zero substitution', () => {
    const active = activeFieldValues(new Float64Array([1, 2, 3]), new Uint8Array([0, 1, 0]), 3);
    expect(active.values[0]).toBe(1);
    expect(Number.isNaN(active.values[1])).toBe(true);
    expect(active.values[2]).toBe(3);
    expect([...active.missing]).toEqual([0, 1, 0]);
    expect(active.missingCount).toBe(1);
    const absent = activeFieldValues(new Float64Array([4, 5]), undefined, 2);
    expect([...absent.missing]).toEqual([0, 0]);
  });

  it('keeps rain missingness independent from lift inputs', () => {
    const rain = precipitationRate(new Float32Array([1.5, 2.5, 3.5]), new Uint8Array([0, 0, 1]), 1);
    expect(rain[0]).toBe(1.5);
    expect(rain[1]).toBe(2.5);
    expect(Number.isNaN(rain[2])).toBe(true);
    const twoHour = precipitationRate(new Float32Array([2, 4]), new Uint8Array([0, 0]), 2);
    expect([...twoHour]).toEqual([1, 2]);
  });
});
