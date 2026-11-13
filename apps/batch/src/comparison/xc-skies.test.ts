import { describe, expect, it } from 'vitest';
import { normalizeXcPointInfo, normalizeXcProfile, normalizeXcRuntimes, parseXcPayload,
  type XcCaptureOptions } from './xc-skies.js';

const firstEpoch = Date.parse('2026-11-13T12:00:00Z') / 1000;
const runtimes = () => normalizeXcRuntimes({ runtimes: { iconeu: [
  { zday: 20261113, zrun: 0, fhour: 12, epoch: firstEpoch, state: 'valid' },
  { zday: 20261113, zrun: 0, fhour: 13, epoch: firstEpoch + 3600, state: 'valid' }
] } });

function options(changes: Partial<XcCaptureOptions> = {}): XcCaptureOptions {
  return { siteId: 'valley', lat: 39.5, lon: 44.9, model: 'icon-eu', sourceRef: 'captures/xc.json',
    runtimesBefore: runtimes(), runtimesAfter: runtimes(), ...changes };
}

function profile(changes: Record<string, unknown> = {}) {
  return { status: 1, epochs: [firstEpoch, firstEpoch + 3600], elevs: [100, 100], vtops: [95, 175], bltops: [140, 200],
    dalrtops: [[1100, 900, 5], [1800, 800, 2]], ntmp2m: [6.1, 7.3], dptops: [160, 180], cutops: [180, 240],
    windavg: [15, 25], precip: [0, 12], cldmax: [20, 70], u10m: [10, 20], tmp2m: [61, 73],
    ntmp: [[5.3, 4, 3], [6.2, 5, 4]], npress: [[900, 880, 860], [901, 881, 861]],
    ndp: [[-3, -4, -5], [-2, -3, -4]], nhgt: [[1000, 1300], [1000, 1300]], ninterval: 150, ...changes };
}

describe('XC response decoding', () => {
  it('parses JSON and strict JSONP without accepting executable arguments or trailing code', () => {
    expect(parseXcPayload('{"status":1}')).toEqual({ status: 1 });
    expect(parseXcPayload(' d3.jsonp.capture({"status":1}); ')).toEqual({ status: 1 });
    for (const text of ['callback((() => 1)())', 'callback({}); alert(1)', 'callback({x:1})', 'callback({"x":1},2)']) {
      expect(() => parseXcPayload(text)).toThrow();
    }
    expect(() => parseXcPayload(' '.repeat(8 * 1024 ** 2 + 1))).toThrow('budget');
  });

  it('derives cycle only when zday/zrun plus fhour agree with the runtime epoch', () => {
    expect(runtimes()[0]).toEqual({ model: 'icon-eu', xcModel: 'iconeu', cycle: '2026-11-13T00:00:00.000Z',
      validTime: '2026-11-13T12:00:00.000Z', forecastHour: 12, state: 'valid' });
    expect(() => normalizeXcRuntimes({ runtimes: { gfs: [
      { zday: 20261113, zrun: 6, fhour: 12, epoch: firstEpoch, state: 'valid' }
    ] } })).toThrow('cycle plus forecast');
    const repeated = { zday: 20261113, zrun: 0, fhour: 12, epoch: firstEpoch, state: 'valid' };
    expect(() => normalizeXcRuntimes({ runtimes: { gfs: [repeated, repeated] } })).toThrow('Duplicate');
  });

  it('applies verified height/wind/rain scaling and keeps conservative height separate', () => {
    const result = normalizeXcProfile(profile(), options());
    const first = result.samples[0]!, next = result.samples[1]!;
    expect(first).toMatchObject({ cycle: '2026-11-13T00:00:00.000Z', groundM: 1000,
      product: 'dwd-icon-eu-regular-0p0625' });
    expect(first.values['usable-lift-msl']).toMatchObject({ value: null, status: 'no-lift' });
    expect(first.values['usable-lift-agl']).toMatchObject({ value: 0, status: 'no-lift', verticalReference: 'XC-ground-AGL' });
    expect(next.values['usable-lift-msl']).toMatchObject({ value: 1750, unit: 'm', verticalReference: 'MSL', timeSupport: 'unknown' });
    expect(next.values['usable-lift-agl']?.value).toBe(750);
    expect(next.values['thermal-top-msl']?.value).toBe(2000);
    expect(next.values['xc-conservative-top-msl']?.value).toBe(1800);
    expect(next.values['sfc-temp-c']?.value).toBe(7.3);
    expect(next.values['xc-bl-mean-wind-speed']?.value).toBe(2.5);
    expect(next.values['xc-precipitation']).toMatchObject({ unit: 'mm', timeSupport: 'unknown' });
    expect(next.values['xc-precipitation']?.value).toBeCloseTo(1.2);
    expect(result.unmappedFields).toContain('u10m');
    expect(result.unmappedFields).toContain('tmp2m');
    expect(next.values['wind-10m-u']).toBeUndefined();
  });

  it('retains native profile physical units and the provider height axis', () => {
    const result = normalizeXcProfile(profile(), options());
    expect(result.profiles[0]?.levels).toEqual([
      { heightM: 1000, pressureHpa: 900, temperatureC: 5.3, dewPointC: -3 },
      { heightM: 1150, pressureHpa: 880, temperatureC: 4, dewPointC: -4 },
      { heightM: 1300, pressureHpa: 860, temperatureC: 3, dewPointC: -5 }
    ]);
  });

  it('reports conditional cloud base as unavailable when it exceeds the boundary layer or is zero', () => {
    const result = normalizeXcProfile(profile(), options());
    expect(result.samples[0]?.values['xc-cloud-base-msl']).toMatchObject({ value: null, status: 'unavailable' });
    expect(result.samples[1]?.values['xc-cloud-base-msl']?.value).toBe(1800);
    expect(result.samples[1]?.values['xc-cloud-top-msl']?.value).toBe(2400);
    const zero = normalizeXcProfile(profile({ dptops: [0, 0] }), options());
    expect(zero.samples.every(row => row.values['xc-cloud-base-msl']?.value === null)).toBe(true);
  });

  it('leaves cycles unknown when runtime snapshots are missing or change during capture', () => {
    expect(normalizeXcProfile(profile(), options({ runtimesBefore: undefined })).samples.every(row => row.cycle === null)).toBe(true);
    const after = runtimes().map(row => ({ ...row, cycle: '2026-11-13T06:00:00.000Z', forecastHour: row.forecastHour - 6 }));
    const changed = normalizeXcProfile(profile(), options({ runtimesAfter: after }));
    expect(changed.samples.every(row => row.cycle === null)).toBe(true);
    expect(changed.diagnostics).toContain('2 profile frames lack stable before/after runtime identity.');
  });

  it('rejects subscription responses, misaligned time arrays, duplicate epochs, and native axes', () => {
    expect(() => normalizeXcProfile(profile({ status: -1 }), options())).toThrow('authentication');
    expect(() => normalizeXcProfile(profile({ vtops: [1] }), options())).toThrow('time axis');
    expect(() => normalizeXcProfile(profile({ epochs: [firstEpoch, firstEpoch] }), options())).toThrow('distinct');
    expect(() => normalizeXcProfile(profile({ npress: [[900], [900]] }), options())).toThrow('axes');
    expect(() => normalizeXcProfile(profile({ nhgt: [[1000, 1100], [1000, 1100]] }), options())).toThrow('height range');
  });

  it('decodes physical pointinfo values and preserves missing sentinels without rescaling', () => {
    const data = { elev: 1050, iconeu: [{ xclift225: 1825 }, { xcbldepth: 775 }, { xcm0: 2200 },
      { xcstemp: 12.3 }, { xccbase: 0 }, { xccdepth: 600 }, { xccape: -9999 }, { xcti: 10 }] };
    const result = normalizeXcPointInfo(data, { ...options(), validTime: '2026-11-13T12:00:00.000Z' });
    expect(result.samples[0]?.values['usable-lift-msl']?.value).toBe(1825);
    expect(result.samples[0]?.values['sfc-temp-c']).toMatchObject({ value: 12.3, definition: 'terrain-interpolated-air-temperature' });
    expect(result.samples[0]?.values['xc-cloud-base-msl']).toMatchObject({ value: null, status: 'unavailable' });
    expect(result.samples[0]?.values['cape-jkg']).toMatchObject({ value: null, status: 'unavailable' });
    expect(result.samples[0]?.values['xc-cloud-depth']).toMatchObject({ value: 600, unit: 'm', verticalReference: 'cloud-depth' });
    expect(result.unmappedFields).toEqual(['xcti']);
    expect(() => normalizeXcPointInfo({ iconeu: [{ xcm0: 1 }, { xcm0: 2 }] },
      { ...options(), validTime: '2026-11-13T12:00:00.000Z' })).toThrow('Duplicate');
  });
});
