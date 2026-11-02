import { describe, expect, it } from 'vitest';
import {
  DEFAULT_HORIZON_DEG,
  createGridDaylightTester,
  isDaylightAtTimestamps,
  solarEphemeris,
  solarFluxFactor,
  solarPosition,
  sunriseSunset
} from './index.js';

describe('@av/solar', () => {
  it('computes high noon solar elevation and daylight in Seattle on summer solstice', () => {
    const noonUtc = Date.parse('2025-06-21T20:15:00Z');
    const pos = solarPosition(47.6062, -122.3321, noonUtc);
    expect(pos.elevationDeg).toBeGreaterThan(64);
    expect(pos.elevationDeg).toBeLessThan(67);
    expect(pos.isDaylight).toBe(true);
    expect(solarFluxFactor(47.6062, -122.3321, noonUtc)).toBeGreaterThan(0.85);
  });

  it('computes nighttime elevation and zero solar flux at local midnight', () => {
    const midnightUtc = Date.parse('2025-06-21T08:00:00Z');
    const pos = solarPosition(47.6062, -122.3321, midnightUtc);
    expect(pos.elevationDeg).toBeLessThan(-15);
    expect(pos.isDaylight).toBe(false);
    expect(solarFluxFactor(47.6062, -122.3321, midnightUtc)).toBe(0);
  });

  it('computes normal, polar-day, and polar-night sunrise/sunset regimes', () => {
    const dayStart = Date.parse('2025-06-21T00:00:00Z');

    const seattle = sunriseSunset(47.6062, -122.3321, dayStart);
    expect(seattle.kind).toBe('normal');
    expect(seattle.dayLengthHours).toBeGreaterThan(15.5);
    expect(seattle.dayLengthHours).toBeLessThan(16.2);
    expect(seattle.sunriseMs).not.toBeNull();
    expect(seattle.sunsetMs).not.toBeNull();
    expect(seattle.sunsetMs! - seattle.sunriseMs!).toBeGreaterThan(15 * 3_600_000);

    const tromsoSummer = sunriseSunset(69.6492, 18.9553, dayStart);
    expect(tromsoSummer.kind).toBe('polar-day');
    expect(tromsoSummer.dayLengthHours).toBe(24);
    expect(tromsoSummer.sunriseMs).toBeNull();
    expect(tromsoSummer.sunsetMs).toBeNull();

    const tromsoWinter = sunriseSunset(69.6492, 18.9553, Date.parse('2025-12-21T00:00:00Z'));
    expect(tromsoWinter.kind).toBe('polar-night');
    expect(tromsoWinter.dayLengthHours).toBe(0);
    expect(tromsoWinter.sunriseMs).toBeNull();
    expect(tromsoWinter.sunsetMs).toBeNull();
  });

  it('evaluates regular-latlon and projected grid daylight identically to point solarPosition and rejects out-of-bounds indices', () => {
    const timestamps = [
      Date.parse('2026-03-29T11:00:00Z'),
      Date.parse('2026-03-29T12:00:00Z')
    ];
    const regularGrid = {
      kind: 'regular-latlon' as const,
      width: 4,
      height: 3,
      north: 60,
      west: -120,
      dLat: 30,
      dLon: 60
    };
    const contractsGrid = {
      kind: 'regular-latlon' as const,
      width: 4,
      height: 3,
      lat0: 60,
      lon0: -120,
      dx: 60,
      dy: -30
    };
    const testRegular = createGridDaylightTester(regularGrid, timestamps, DEFAULT_HORIZON_DEG);
    const testContracts = createGridDaylightTester(contractsGrid, timestamps, DEFAULT_HORIZON_DEG);

    const projectedGrid = {
      kind: 'projected' as const,
      width: regularGrid.width,
      height: regularGrid.height,
      gridToGeographic: (col: number, row: number) => ({
        lat: regularGrid.north - row * regularGrid.dLat,
        lon: regularGrid.west + col * regularGrid.dLon
      })
    };
    const testProjected = createGridDaylightTester(projectedGrid, timestamps, DEFAULT_HORIZON_DEG);

    for (let row = 0; row < regularGrid.height; row += 1) {
      for (let col = 0; col < regularGrid.width; col += 1) {
        const index = row * regularGrid.width + col;
        const lat = regularGrid.north - row * regularGrid.dLat;
        const lon = regularGrid.west + col * regularGrid.dLon;
        const expected = isDaylightAtTimestamps(lat, lon, timestamps, DEFAULT_HORIZON_DEG);
        expect(testRegular(index)).toBe(expected);
        expect(testContracts(index)).toBe(expected);
        expect(testProjected(index)).toBe(expected);
      }
    }

    // Out-of-bounds or non-integer indices must never evaluate true even when horizonDeg < 0
    for (const badIndex of [-1, 12, 999, 1.5, NaN]) {
      expect(testRegular(badIndex)).toBe(false);
      expect(testContracts(badIndex)).toBe(false);
      expect(testProjected(badIndex)).toBe(false);
    }

    // At 11:00-12:00 UTC:
    // col 0 (lon = -120, West Coast US, ~03:00-04:00 local) is dark at equator (row 1)
    expect(testRegular(1 * regularGrid.width + 0)).toBe(false);
    // col 2 (lon = 0, Prime Meridian, 11:00-12:00 local) is bright at equator (row 1)
    expect(testRegular(1 * regularGrid.width + 2)).toBe(true);
    expect(solarEphemeris(timestamps[0]!).distanceFactor).toBeGreaterThan(0.95);
  });

  it('guards against non-finite inputs without throwing or returning NaN normal sunrises', () => {
    expect(solarEphemeris(NaN).declinationDeg).toBeNaN();
    expect(solarPosition(NaN, -122, Date.now()).isDaylight).toBe(false);
    expect(solarFluxFactor(NaN, -122, Date.now())).toBe(0);
    expect(sunriseSunset(NaN, -122, Date.now())).toEqual({
      kind: 'polar-night',
      solarNoonMs: NaN,
      sunriseMs: null,
      sunsetMs: null,
      dayLengthHours: 0
    });
  });
});
