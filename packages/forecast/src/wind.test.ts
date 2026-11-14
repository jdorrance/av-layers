import { describe, expect, it } from 'vitest';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import { windLayout } from '@av/contracts/wind-data';
import { planSample, sampleCells } from './sampler.ts';
import { decodePackedWindChunk, encodeWindColumns, normalizedWindColumn, samplePackedWindColumns, windTargetHeight, type WindVector } from './wind.ts';

import type { ModelLevelFrame } from './inputs.ts';

type WindColumn = { surface: WindVector | null; levels: ({ height: number; wind: WindVector } | null)[] };
const column: WindColumn = { surface: { u: 0, v: 0 }, levels: [{ height: 100, wind: { u: 1, v: -1 } }, null, { height: 300, wind: { u: 3, v: -3 } }, { height: 400, wind: { u: 4, v: -4 } }] };
const plan = planSample({ kind: 'regular-latlon', width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false }, 0.5, 0.5)!;

function windAtHeight(column: WindColumn, height: number | 'surface'): WindVector | null {
  if (height === 'surface') return column.surface;
  for (let i = 0; i < column.levels.length; i++) {
    const a = column.levels[i], b = column.levels[i + 1];
    if (a && height === a.height) return a.wind;
    if (a && b && a.height < height && height < b.height) {
      const t = (height - a.height) / (b.height - a.height);
      return { u: a.wind.u + t * (b.wind.u - a.wind.u), v: a.wind.v + t * (b.wind.v - a.wind.v) };
    }
  }
  return null;
}

function sampleWindColumns(columns: readonly (WindColumn | null)[], height: number | 'surface') {
  const winds = columns.map(item => item ? windAtHeight(item, height) : null);
  const component = (key: 'u' | 'v') => sampleCells(plan, winds.map((wind, i) => ({ value: wind?.[key] ?? NaN, flags: wind ? STATUS_VALID : columns[i] ? STATUS_UNAVAILABLE : STATUS_OUTSIDE })), 'wind-10m-u', false);
  const u = component('u'), v = component('v');
  return { u: u.value, v: v.value, status: u.status, interpolated: u.interpolated };
}

function nearSurfaceFrame(): ModelLevelFrame {
  const values = (value: number) => Float32Array.of(value), missing = () => Uint8Array.of(0);
  const field = (value: number) => ({ values: values(value), missing: missing() });
  const time = '2026-11-13T09:00:00Z', window = { start: time, end: time };
  return {
    cycle: time, hour: 0, validAt: time, capturedAt: time,
    grid: { kind: 'regular-latlon', width: 1, height: 1, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false },
    activeIndices: Uint32Array.of(0), terrainM: values(1000), surfacePressurePa: values(100000),
    temp2mK: values(290), specificHumidity2mKgKg: values(0.01), sensibleHeatFluxWm2: values(100), latentHeatFluxWm2: values(100),
    hgtM: [1024, 1100, 1300].map(values), pressurePa: [99000, 97000, 94000].map(values), tempK: [289, 288, 286].map(values),
    auxSurface: { u10mMps: field(2), v10mMps: field(4) },
    auxLevels: { uWindMps: [16, 30, 50].map(field), vWindMps: [18, 32, 52].map(field) },
    missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(),
      hgt: Array.from({ length: 3 }, missing), pressure: Array.from({ length: 3 }, missing), temp: Array.from({ length: 3 }, missing) },
    intervals: { profileTime: time, fluxWindow: window, fluxSourceWindow: window, usedCompanion: false }, receipt: {}
  };
}

describe('wind columns', () => {
  it('brackets 20 m AGL between paired 10 m wind and the first model level', () => {
    const frame = nearSurfaceFrame(), normalized = normalizedWindColumn(frame, 0);
    expect(normalized.levels).toHaveLength(frame.hgtM.length + 1);
    expect(normalized.levels[0]).toEqual({ height: 1010, wind: { u: 2, v: 4 } });
    const chunk = decodePackedWindChunk(encodeWindColumns([normalized]));
    const single = { ...plan, contributors: [{ ...plan.contributors[0], weight: 1 }] };
    expect(samplePackedWindColumns(single, [chunk], [0], 1020)).toMatchObject({ u: 12, v: 14, status: STATUS_VALID });
    expect(samplePackedWindColumns(single, [chunk], [0], 1009)).toMatchObject({ u: null, v: null, status: STATUS_UNAVAILABLE });
    expect(samplePackedWindColumns(single, [chunk], [0], 'surface')).toMatchObject({ u: 2, v: 4, status: STATUS_VALID });
  });

  it.each(['pressure', 'height'] as const)('places the anchor after native levels proved below ground by %s', proof => {
    const frame = nearSurfaceFrame();
    frame.hgtM[0][0] = proof === 'height' ? 990 : NaN;
    frame.missing.hgt[0][0] = proof === 'height' ? 0 : 1;
    frame.pressurePa[0][0] = proof === 'pressure' ? 101000 : NaN;
    frame.missing.pressure[0][0] = proof === 'pressure' ? 0 : 1;
    const normalized = normalizedWindColumn(frame, 0);
    expect(normalized.levels[0]).toBeNull();
    expect(normalized.levels[1]).toEqual({ height: 1010, wind: { u: 2, v: 4 } });
    expect(normalized.levels[2]?.height).toBe(1100);
  });

  it.each(['surface-u', 'surface-v', 'terrain', 'ground-pressure', 'first-u', 'first-v', 'first-height', 'first-pressure'] as const)('keeps the near-surface interval unavailable with missing %s', field => {
    const frame = nearSurfaceFrame();
    if (field === 'surface-u') frame.auxSurface!.u10mMps!.missing[0] = 1;
    if (field === 'surface-v') frame.auxSurface!.v10mMps!.missing[0] = 1;
    if (field === 'terrain') frame.missing.terrain[0] = 1;
    if (field === 'ground-pressure') frame.missing.surfacePressure[0] = 1;
    if (field === 'first-u') frame.auxLevels!.uWindMps![0].missing[0] = 1;
    if (field === 'first-v') frame.auxLevels!.vWindMps![0].missing[0] = 1;
    if (field === 'first-height') frame.missing.hgt[0][0] = 1;
    if (field === 'first-pressure') frame.missing.pressure[0][0] = 1;
    const normalized = normalizedWindColumn(frame, 0);
    expect(normalized.levels[0]).toBeNull();
    expect(windAtHeight(normalized, 1020)).toBeNull();
  });

  it('preserves missing interior intervals and native levels below 10 m', () => {
    const frame = nearSurfaceFrame();
    frame.auxLevels!.uWindMps![1].missing[0] = 1;
    const normalized = normalizedWindColumn(frame, 0);
    expect(normalized.levels[0]?.height).toBe(1010);
    expect(normalized.levels[2]).toBeNull();
    expect(windAtHeight(normalized, 1200)).toBeNull();
    frame.hgtM[0][0] = 1005;
    const low = normalizedWindColumn(frame, 0);
    expect(low.levels[0]).toBeNull();
    expect(low.levels[1]?.height).toBe(1005);
    expect(() => encodeWindColumns([low])).not.toThrow();
  });

  it('round trips paired values, missing levels and outside cells', () => {
    const chunk = decodePackedWindChunk(encodeWindColumns([column, null]));
    const single = { ...plan, contributors: [{ ...plan.contributors[0], weight: 1 }] };
    expect(samplePackedWindColumns(single, [chunk], [0], 350)).toEqual({ u: 3.5, v: -3.5, status: STATUS_VALID, interpolated: false });
    expect(samplePackedWindColumns(single, [chunk], [1], 'surface')).toEqual({ u: null, v: null, status: STATUS_OUTSIDE, interpolated: false });
  });
  it('rejects malformed, oversized, and nonmonotonic data', () => {
    expect(() => decodePackedWindChunk(new Uint8Array(262145))).toThrow();
    const bytes = encodeWindColumns([column]); bytes[4] = 2;
    expect(() => decodePackedWindChunk(bytes)).toThrow();
    expect(() => encodeWindColumns([{ surface: null, levels: [{ height: 100, wind: { u: 1, v: 1 } }, { height: 99, wind: { u: 1, v: 1 } }] }])).toThrow();
  });
  it('preserves lift majority and stored MSL interpolation', () => {
    const cells = [2000, 500, 500, 500].map((value, index) => ({ value, flags: index ? STATUS_NO_LIFT : STATUS_VALID }));
    expect(windTargetHeight(plan, cells, { lift: true }, true).status).toBe(STATUS_NO_LIFT);
    cells[1] = { value: 2000, flags: STATUS_VALID };
    expect(windTargetHeight(plan, cells, { lift: true }, true)).toMatchObject({ status: STATUS_VALID, value: 1250 });
  });
  it('matches object sampling for exact levels, gaps, interpolation and nearest ties', () => {
    const other: WindColumn = { surface: { u: -2, v: 8 }, levels: [{ height: 100, wind: { u: -1, v: 4 } }, null, { height: 300, wind: { u: -3, v: 12 } }, { height: 400, wind: { u: -4, v: 16 } }] };
    for (const columns of [[column, other, column, other], [column, null, other, column], [null, column, other, column]]) {
      const chunk = decodePackedWindChunk(encodeWindColumns(columns));
      for (const height of ['surface', 100, 200, 300, 350, 400, 500, NaN] as const) {
        expect(samplePackedWindColumns(plan, [chunk, chunk, chunk, chunk], [0, 1, 2, 3], height)).toEqual(sampleWindColumns(columns, height));
      }
    }
    const reversed = { ...plan, contributors: [...plan.contributors].reverse() };
    const chunk = decodePackedWindChunk(encodeWindColumns([null, column, column, column]));
    expect(samplePackedWindColumns(reversed, [chunk, chunk, chunk, chunk], [3, 2, 1, 0], 'surface')).toEqual({ u: null, v: null, status: STATUS_OUTSIDE, interpolated: false });
  });
  it('renormalizes above-ground donors across sloped terrain without bridging missing near-surface data', () => {
    const valley: WindColumn = { surface: { u: 2, v: 4 }, levels: [{ height: 1010, wind: { u: 2, v: 4 } }, { height: 1100, wind: { u: 11, v: 22 } }, { height: 1300, wind: { u: 20, v: 40 } }] };
    const midSlope: WindColumn = { surface: { u: 4, v: 8 }, levels: [{ height: 1030, wind: { u: 4, v: 8 } }, { height: 1120, wind: { u: 13, v: 26 } }, { height: 1300, wind: { u: 20, v: 40 } }] };
    const ridge: WindColumn = { surface: { u: 6, v: 12 }, levels: [{ height: 1200, wind: { u: 6, v: 12 } }, { height: 1300, wind: { u: 20, v: 40 } }, { height: 1500, wind: { u: 25, v: 50 } }] };
    const missingNearSurface: WindColumn = { surface: { u: 6, v: 12 }, levels: [null, null, { height: 1200, wind: { u: 18, v: 36 } }] };
    const sloped = decodePackedWindChunk(encodeWindColumns([valley, midSlope, ridge, ridge]));
    const uphill = planSample({ kind: 'regular-latlon', width: 2, height: 2, lon0: 0, lat0: 0, dx: 1, dy: 1, earthRadiusM: 6371000, wrapLongitude: false }, 0.8, 0.5)!;
    // Nearest contributors (row 1, weight 0.8) are underground at 1055 m MSL, so valid row-0 donors (0.1 + 0.1) renormalize cleanly.
    const blended = samplePackedWindColumns(uphill, [sloped, sloped, sloped, sloped], [0, 1, 2, 3], 1055);
    expect(blended.status).toBe(STATUS_VALID);
    expect(blended.interpolated).toBe(true);
    expect(blended.u).toBeCloseTo((6.5 + (4 + 25 / 90 * 9)) / 2, 5);
    expect(blended.v).toBeCloseTo((13 + (8 + 25 / 90 * 18)) / 2, 5);
    // Below all 4 columns remains unavailable instead of extrapolating underground.
    expect(samplePackedWindColumns(uphill, [sloped, sloped, sloped, sloped], [0, 1, 2, 3], 1005)).toEqual({ u: null, v: null, status: STATUS_UNAVAILABLE, interpolated: false });
    // A column with genuinely missing near-surface wind is not treated as underground.
    const gapped = decodePackedWindChunk(encodeWindColumns([valley, midSlope, missingNearSurface, missingNearSurface]));
    expect(samplePackedWindColumns(uphill, [gapped, gapped, gapped, gapped], [0, 1, 2, 3], 1055)).toEqual({ u: null, v: null, status: STATUS_UNAVAILABLE, interpolated: false });
  });
  it('derives native and fine layout including partial pages', () => {
    const wind = windLayout(16 * 1025, 16, 16, 21), fine = windLayout(64, 64, 64);
    expect([wind.count, wind.chunkBytes, wind.pages, wind.pageCount(0), wind.pageCount(1)]).toEqual([1025, 12 + 256 * (9 + 13 * 21), 3, 512, 512]);
    expect([fine.count, fine.chunkBytes, fine.pages, fine.pageCount(0)]).toEqual([1, 64 * 64 * 10, 1, 1]);
  });
  it('validates packed fields without expanding high-level-count chunks', () => {
    const levels = Array.from({ length: 256 }, (_, i) => ({ height: i + 1, wind: { u: i, v: -i } }));
    const bytes = encodeWindColumns([{ surface: null, levels }]);
    const chunk = decodePackedWindChunk(bytes);
    expect(chunk.view.buffer).toBe(bytes.buffer);
    expect(chunk.levels).toBe(256);
    const corrupt = bytes.slice(); corrupt[12 + 9 + 12] = 7;
    expect(() => decodePackedWindChunk(corrupt)).toThrow();
  });
});
