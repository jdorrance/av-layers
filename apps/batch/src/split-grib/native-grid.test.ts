import { describe, expect, it } from 'vitest';
import type { RegularLatLonGrid } from '@av/contracts';
import { prepareNativeMapping } from './native-grid.js';

const grid: RegularLatLonGrid = { kind: 'regular-latlon', width: 3, height: 2, earthRadiusM: 6_371_229,
  lon0: 7, lat0: 46, dx: 0.0625, dy: -0.0625, wrapLongitude: false };

describe('native nearest-cell mapping', () => {
  it('preserves requested order and reuses one native column for nearby targets', () => {
    const latitudes = Float64Array.of(46, 45.9375), longitudes = Float64Array.of(7.0625, 7.0625);
    expect([...prepareNativeMapping(grid, Uint32Array.of(5, 0, 1, 3, 2, 4), latitudes, longitudes)]).toEqual([1, 0, 0, 1, 0, 1]);
  });

  it.each([[0, 179.99], [89.95, -179.99], [-89.95, 179.99], [80, 20], [46, 7], [90, 180]] as const)(
    'matches spherical brute-force distances around latitude %s longitude %s', (latitude, longitude) => {
      const target = { ...grid, width: 1, height: 1, lat0: latitude, lon0: longitude };
      const latitudes = new Float64Array(100), longitudes = new Float64Array(100);
      const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180;
      for (let i = 0; i < latitudes.length; i++) {
        latitudes[i] = Math.max(-90, Math.min(90, latitude + Math.sin(i * 1.7) * 0.08));
        longitudes[i] = wrap(longitude + Math.cos(i * 2.1) * (Math.abs(latitude) > 89 ? 90 : 0.5));
      }
      const radians = Math.PI / 180;
      const haversine = (i: number) => Math.sin((latitudes[i]! - latitude) * radians / 2) ** 2 +
        Math.cos(latitude * radians) * Math.cos(latitudes[i]! * radians) * Math.sin((longitudes[i]! - longitude) * radians / 2) ** 2;
      let expected = 0;
      for (let i = 1; i < latitudes.length; i++) if (haversine(i) < haversine(expected)) expected = i;
      expect(prepareNativeMapping(target, Uint32Array.of(0), latitudes, longitudes)[0]).toBe(expected);
    }
  );

  it('breaks equal-distance ties by native index', () => {
    const target = { ...grid, width: 1, height: 1, lat0: 0, lon0: 0 };
    expect(prepareNativeMapping(target, Uint32Array.of(0), Float64Array.of(0, 0), Float64Array.of(0.01, -0.01))[0]).toBe(0);
  });

  it('rejects coordinates and target indices before building the mapping', () => {
    const active = Uint32Array.of(0), latitude = Float64Array.of(46), longitude = Float64Array.of(7);
    for (const invalid of [NaN, Infinity, 90.01, -90.01]) {
      expect(() => prepareNativeMapping(grid, active, Float64Array.of(invalid), longitude)).toThrow(/Invalid native coordinate/);
    }
    expect(() => prepareNativeMapping(grid, active, latitude, Float64Array.of(181))).toThrow(/Invalid native coordinate/);
    expect(() => prepareNativeMapping(grid, active, new Float64Array(), longitude)).toThrow(/Invalid native mapping dimensions/);
    expect(() => prepareNativeMapping(grid, Uint32Array.of(6), latitude, longitude)).toThrow(/Invalid native mapping target/);
  });

  it('rejects targets beyond the maximum distance instead of extending a native edge', () => {
    expect(() => prepareNativeMapping(grid, Uint32Array.of(0), Float64Array.of(46.1), Float64Array.of(7))).toThrow(/No native cell within 10000 m/);
  });
});
