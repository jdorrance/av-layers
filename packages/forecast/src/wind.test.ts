import { describe, expect, it } from 'vitest';
import { STATUS_NO_LIFT, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID } from '@av/contracts/layers';
import { windLayout } from '@av/contracts/wind-data';
import { planSample, sampleCells } from './sampler.ts';
import { decodePackedWindChunk, encodeWindColumns, samplePackedWindColumns, windTargetHeight, type WindVector } from './wind.ts';

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

describe('wind columns', () => {
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
