import { describe, expect, it } from 'vitest';
import { normalizeSkySightPoint, normalizeSkySightWindgram, parseSkySightPayload, SKY_SIGHT_MAPPINGS,
  SKY_SIGHT_WINDGRAM_MAPPINGS, type SkySightCaptureOptions } from './skysight.js';

const options: SkySightCaptureOptions = { siteId: 'ridge', lat: 47.1, lon: 11.3, region: 'EUROPE',
  sourceRef: 'captures/skysight.json', capturedAt: '2026-11-13T11:00:00Z', requestedTimes: ['202611131000', '202611131030'] };
function point() {
  return { times: [...options.requestedTimes!], HGT: [2508, 2508], hwcrit: [2743.6, 2508], dwcrit: [235.9, 0],
    sfctemp: [-6.3, null], sfcdewpt: [-9.4, -9.1], CFRACH: [0, 20], wstar: [0.2, 0], mslpress: [1002, 1003],
    accrain: [0.4, 0], sfcgust: [8.2, 4.6], sfcshf: [46.6, 50],
    twilights: ['1794548777'], real_sfctemp: [] };
}
function windgram() {
  return { base: '2508.1', vertical_grid: 'native', data: options.requestedTimes!.map(dt => ({ dt,
    cfracl: 0, cfrach: 21.77, pblh: 2671, zsfclcl: 2802, accrain: 0, cape: 0,
    data: [{ altitude: 2508.14, u: '1.42', v: '-4.08', temp: '-6.6', press: '737.84', base: '2508.1' },
      { altitude: 2525.47, u: '1.76', v: '-5.95', temp: '-6.9', press: '736.28', base: '2508.1' }]
  })) };
}

describe('SkySight captured product decoding', () => {
  it('accepts bounded JSON and rejects executable or oversized inputs', () => {
    expect(parseSkySightPayload('{"base":0}')).toEqual({ base: 0 });
    expect(() => parseSkySightPayload('callback({"base":0})')).toThrow();
    expect(() => parseSkySightPayload(' '.repeat(8 * 1024 ** 2 + 1))).toThrow('budget');
  });

  it('keeps regional endpoint identities, unknown cycle and the explicit no-lift status', () => {
    const result = normalizeSkySightPoint(point(), options);
    expect(result.samples[0]).toMatchObject({ provider: 'skysight', model: 'skysight', product: 'skysight-europe-point',
      cycle: null, groundM: 2508, validTime: '2026-11-13T10:00:00.000Z', capturedAt: options.capturedAt });
    expect(result.samples[0]!.values['usable-lift-msl']).toMatchObject({ value: 2743.6, unit: 'm', definition: 'thermal-top-at-175fpm' });
    expect(result.samples[0]!.values['usable-lift-agl']).toMatchObject({ value: 235.9, verticalReference: 'SkySight-ground-AGL' });
    expect(result.samples[1]!.values['usable-lift-msl']).toMatchObject({ value: null, status: 'no-lift' });
    expect(result.samples[1]!.values['usable-lift-agl']).toMatchObject({ value: 0, status: 'no-lift' });
    expect(result.samples[1]!.values['sfc-temp-c']).toMatchObject({ value: null, status: 'unavailable' });
    expect(result.samples[0]!.values['skysight-thermal-strength']).toMatchObject({ value: 0.2, unit: 'm/s' });
    expect(result.samples[0]!.values['skysight-cloud-cover-high']).toMatchObject({ value: 0, unit: '%' });
    expect(result.samples[0]!.values['skysight-surface-gust']).toMatchObject({ value: 8.2, unit: 'm/s', verticalReference: '2m-SkySight-AGL', timeSupport: 'unknown' });
    expect(result.unmappedFields).toContain('sfcshf');
    expect(result.unmappedFields).toContain('real_sfctemp');
  });

  it('preserves native wire fields separately from point values and surface temperature', () => {
    const result = normalizeSkySightWindgram(windgram(), options);
    expect(result.samples[0]!.product).toBe('skysight-europe-windgram');
    expect(result.samples[0]!.values['sfc-temp-c']).toBeUndefined();
    expect(result.samples[0]!.values['usable-lift-msl']).toBeUndefined();
    expect(result.profiles[0]!.levels[0]).toEqual({ altitude: 2508.14,
      values: { u: 1.42, v: -4.08, temp: -6.6, press: 737.84, base: 2508.1 }, available: true });
    expect(result.profiles[0]!.scalars.cfrach).toBe(21.77);
    expect(result.samples[0]!.values['skysight-boundary-top-msl']).toMatchObject({ value: 2671, unit: 'm', verticalReference: 'MSL' });
    expect(result.samples[0]!.values['skysight-cloud-cover-high']).toMatchObject({ value: 21.77, unit: '%' });
    expect(result.samples[0]!.values['skysight-cape']).toMatchObject({ value: 0, unit: 'J' });
    expect(result.rawFields).toContain('data[].data[].temp');
    const missing = windgram(); missing.data[0]!.data[0]!.press = '0';
    expect(normalizeSkySightWindgram(missing, options).profiles[0]!.levels[0]!.available).toBe(false);
  });

  it('rejects calendar rollovers, duplicate or mismatched request times and ragged scalar arrays', () => {
    for (const times of [['202602301000'], ['202611132400'], ['202611131000', '202611131000']]) {
      expect(() => normalizeSkySightPoint({ ...point(), times }, { ...options, requestedTimes: undefined })).toThrow();
    }
    expect(() => normalizeSkySightPoint(point(), { ...options, requestedTimes: ['202611131000'] })).toThrow('requested times');
    expect(() => normalizeSkySightPoint({ ...point(), sfctemp: [4] }, options)).toThrow('time axis');
  });

  it('rejects invalid native geometry and numeric values without coercing absence to zero', () => {
    const reversed = windgram(); reversed.data[0]!.data.reverse();
    expect(() => normalizeSkySightWindgram(reversed, options)).toThrow('native heights');
    for (const invalid of ['', 'NaN', '0x10']) {
      const data = windgram(); data.data[0]!.data[0]!.temp = invalid;
      expect(() => normalizeSkySightWindgram(data, options)).toThrow('native temp');
    }
    expect(() => normalizeSkySightWindgram({ ...windgram(), vertical_grid: 'uniform' }, options)).toThrow('native windgram');
    expect(() => normalizeSkySightPoint(point(), { ...options, lat: 91 })).toThrow('capture identity');
  });

  it('masks empty forecasts and zero-pressure frames without reporting no-lift', () => {
    const data = point(); data.mslpress[1] = 0;
    const result = normalizeSkySightPoint(data, options);
    expect(Object.values(result.samples[1]!.values).every(value => value.value === null && value.status === 'unavailable')).toBe(true);
    expect(result.samples[0]!.values['skysight-rain-30m-mm']).toMatchObject({ value: 0.4, unit: 'mm', timeSupport: 'interval-accumulation',
      intervalStart: '2026-11-13T09:30:00.000Z', intervalEnd: '2026-11-13T10:00:00.000Z' });
    expect(normalizeSkySightPoint({ ...point(), sfctemp: [] }, options).samples[0]!.values['sfc-temp-c']).toMatchObject({ value: null, status: 'unavailable' });
    const empty = windgram(); empty.data[0]!.data = [];
    expect(Object.values(normalizeSkySightWindgram(empty, options).samples[0]!.values).every(value => value.status === 'unavailable')).toBe(true);
  });

  it('excludes suspect point cloud placeholders and retains small positive reported depths', () => {
    expect(SKY_SIGHT_MAPPINGS.find(mapping => mapping.id === 'cloud-cover-low')?.comparability).toBe('unmapped');
    expect(SKY_SIGHT_WINDGRAM_MAPPINGS.find(mapping => mapping.id === 'cloud-cover-low')?.comparability).toBe('related');
    const data = point(); data.dwcrit[1] = 0.005;
    const result = normalizeSkySightPoint(data, options);
    expect(result.samples[1]!.values['usable-lift-agl']).toMatchObject({ value: 0.005, status: 'valid' });
    expect(result.samples[0]!.values['skysight-cloud-cover-high']?.value).toBe(0);
  });
});
