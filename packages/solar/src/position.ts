/**
 * NOAA-style solar position, sunrise/sunset, and separable grid daylight approximations.
 *
 * Ported from windgrams/packages/meteorology/src/sun.ts and extended with
 * separable grid ephemeris tables for fast daylight-only forecast derivation.
 */

import { DEFAULT_HORIZON_DEG } from './parameters.js';

import { DEG_TO_RAD, RAD_TO_DEG, clamp, mod } from './geometry.js';
const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const J1970 = 2_440_587.5;
const J2000 = 2_451_545.0;

export interface SolarEphemeris {
  readonly declinationDeg: number;
  readonly sinDeclination: number;
  readonly cosDeclination: number;
  readonly tanDeclination: number;
  readonly equationOfTimeMin: number;
  readonly distanceFactor: number;
  readonly utcMinutes: number;
}

export interface SolarPosition {
  readonly elevationDeg: number;
  readonly azimuthDeg: number;
  readonly zenithDeg: number;
  readonly declinationDeg: number;
  readonly equationOfTimeMin: number;
  readonly distanceFactor: number;
  readonly isDaylight: boolean;
}

export interface SunriseSunset {
  readonly kind: 'normal' | 'polar-day' | 'polar-night';
  readonly solarNoonMs: number;
  readonly sunriseMs: number | null;
  readonly sunsetMs: number | null;
  readonly dayLengthHours: number;
}

const toJulianDay = (ms: number): number => ms / DAY_MS + J1970;

const toJulianCentury = (ms: number): number => (toJulianDay(ms) - J2000) / 36_525;

/**
 * Computes time-dependent solar ephemeris terms for a UTC timestamp in milliseconds.
 */
export const solarEphemeris = (ms: number): SolarEphemeris => {
  if (!Number.isFinite(ms)) {
    return {
      declinationDeg: NaN,
      sinDeclination: NaN,
      cosDeclination: NaN,
      tanDeclination: NaN,
      equationOfTimeMin: NaN,
      distanceFactor: NaN,
      utcMinutes: NaN
    };
  }
  const T = toJulianCentury(ms);

  const geomMeanLongDeg = mod(280.46646 + T * (36_000.76983 + 0.0003032 * T), 360);
  const geomMeanAnomDeg = 357.52911 + T * (35_999.05029 - 0.0001537 * T);
  const eccentEarthOrbit = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const mRad = geomMeanAnomDeg * DEG_TO_RAD;
  const sunEqOfCtr =
    Math.sin(mRad) * (1.914602 - T * (0.004817 + 0.000014 * T)) +
    Math.sin(2 * mRad) * (0.019993 - 0.000101 * T) +
    Math.sin(3 * mRad) * 0.000289;

  const sunTrueLongDeg = geomMeanLongDeg + sunEqOfCtr;
  const omegaRad = (125.04 - 1934.136 * T) * DEG_TO_RAD;
  const sunAppLongDeg = sunTrueLongDeg - 0.00569 - 0.00478 * Math.sin(omegaRad);

  const meanObliqDeg =
    23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const obliqCorrDeg = meanObliqDeg + 0.00256 * Math.cos(omegaRad);

  const obliqRad = obliqCorrDeg * DEG_TO_RAD;
  const appLongRad = sunAppLongDeg * DEG_TO_RAD;
  const sinDeclination = clamp(Math.sin(obliqRad) * Math.sin(appLongRad), -1, 1);
  const declinationRad = Math.asin(sinDeclination);
  const cosDeclination = Math.cos(declinationRad);
  const tanDeclination = Math.tan(declinationRad);

  const y = Math.tan(obliqRad / 2) ** 2;
  const l0Rad = geomMeanLongDeg * DEG_TO_RAD;
  const equationOfTimeMin =
    4 *
    RAD_TO_DEG *
    (y * Math.sin(2 * l0Rad) -
      2 * eccentEarthOrbit * Math.sin(mRad) +
      4 * eccentEarthOrbit * y * Math.sin(mRad) * Math.cos(2 * l0Rad) -
      0.5 * y * y * Math.sin(4 * l0Rad) -
      1.25 * eccentEarthOrbit * eccentEarthOrbit * Math.sin(2 * mRad));

  const trueAnomRad = (geomMeanAnomDeg + sunEqOfCtr) * DEG_TO_RAD;
  const radiusVectorAu =
    (1.000001018 * (1 - eccentEarthOrbit * eccentEarthOrbit)) /
    (1 + eccentEarthOrbit * Math.cos(trueAnomRad));

  return {
    declinationDeg: declinationRad * RAD_TO_DEG,
    sinDeclination,
    cosDeclination,
    tanDeclination,
    equationOfTimeMin,
    distanceFactor: 1 / (radiusVectorAu * radiusVectorAu),
    utcMinutes: mod(ms / MINUTE_MS, 1440)
  };
};

export const solarPosition = (
  latDeg: number,
  lonDeg: number,
  ms: number,
  horizonDeg = DEFAULT_HORIZON_DEG
): SolarPosition => {
  if (
    !Number.isFinite(latDeg) ||
    !Number.isFinite(lonDeg) ||
    !Number.isFinite(ms) ||
    !Number.isFinite(horizonDeg)
  ) {
    return {
      elevationDeg: NaN,
      azimuthDeg: NaN,
      zenithDeg: NaN,
      declinationDeg: NaN,
      equationOfTimeMin: NaN,
      distanceFactor: NaN,
      isDaylight: false
    };
  }
  const latRad = clamp(latDeg, -89.999, 89.999) * DEG_TO_RAD;
  const ephemeris = solarEphemeris(ms);

  const trueSolarTimeMin = mod(
    ephemeris.utcMinutes + ephemeris.equationOfTimeMin + 4 * lonDeg,
    1440
  );
  const hourAngleDeg = trueSolarTimeMin / 4 - 180;
  const hourAngleRad = hourAngleDeg * DEG_TO_RAD;

  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const cosZenith = clamp(
    sinLat * ephemeris.sinDeclination +
      cosLat * ephemeris.cosDeclination * Math.cos(hourAngleRad),
    -1,
    1
  );
  const zenithRad = Math.acos(cosZenith);
  const zenithDeg = zenithRad * RAD_TO_DEG;
  const elevationDeg = 90 - zenithDeg;

  const sinZenith = Math.sin(zenithRad);
  let azimuthDeg = 180;
  if (sinZenith > 1e-7) {
    const cosAzimuth = clamp(
      (sinLat * cosZenith - ephemeris.sinDeclination) / (cosLat * sinZenith),
      -1,
      1
    );
    const baseAzimuth = Math.acos(cosAzimuth) * RAD_TO_DEG;
    azimuthDeg = hourAngleDeg > 0 ? mod(baseAzimuth + 180, 360) : mod(540 - baseAzimuth, 360);
  }

  return {
    elevationDeg,
    azimuthDeg,
    zenithDeg,
    declinationDeg: ephemeris.declinationDeg,
    equationOfTimeMin: ephemeris.equationOfTimeMin,
    distanceFactor: ephemeris.distanceFactor,
    isDaylight: elevationDeg > horizonDeg
  };
};

export const sunriseSunset = (
  latDeg: number,
  lonDeg: number,
  dayStartUtcMs: number,
  horizonDeg = DEFAULT_HORIZON_DEG
): SunriseSunset => {
  if (
    !Number.isFinite(latDeg) ||
    !Number.isFinite(lonDeg) ||
    !Number.isFinite(dayStartUtcMs) ||
    !Number.isFinite(horizonDeg)
  ) {
    return {
      kind: 'polar-night',
      solarNoonMs: NaN,
      sunriseMs: null,
      sunsetMs: null,
      dayLengthHours: 0
    };
  }
  const dayStart = Math.floor(dayStartUtcMs / DAY_MS) * DAY_MS;
  const approxNoonMs = dayStart + (720 - 4 * lonDeg) * MINUTE_MS;
  const noon = solarEphemeris(approxNoonMs);

  const latRad = clamp(latDeg, -89.999, 89.999) * DEG_TO_RAD;
  const zenithRad = (90 - horizonDeg) * DEG_TO_RAD;
  const cosHourAngle =
    Math.cos(zenithRad) / (Math.cos(latRad) * noon.cosDeclination) -
    Math.tan(latRad) * noon.tanDeclination;

  const solarNoonMin = 720 - 4 * lonDeg - noon.equationOfTimeMin;
  const solarNoonMs = dayStart + solarNoonMin * MINUTE_MS;

  if (cosHourAngle < -1) {
    return {
      kind: 'polar-day',
      solarNoonMs,
      sunriseMs: null,
      sunsetMs: null,
      dayLengthHours: 24
    };
  }
  if (cosHourAngle > 1) {
    return {
      kind: 'polar-night',
      solarNoonMs,
      sunriseMs: null,
      sunsetMs: null,
      dayLengthHours: 0
    };
  }

  const hourAngleDeg = Math.acos(clamp(cosHourAngle, -1, 1)) * RAD_TO_DEG;
  const deltaMs = hourAngleDeg * 4 * MINUTE_MS;

  return {
    kind: 'normal',
    solarNoonMs,
    sunriseMs: solarNoonMs - deltaMs,
    sunsetMs: solarNoonMs + deltaMs,
    dayLengthHours: (2 * hourAngleDeg) / 15
  };
};

/**
 * Return both horizon crossings within one local day, with one-second precision.
 */
export function sunriseSunsetInRange(
  latDeg: number,
  lonDeg: number,
  startMs: number,
  endMs: number
): { sunrise: number; sunset: number } | null {
  if (
    ![startMs, endMs, latDeg, lonDeg].every(Number.isFinite) ||
    endMs <= startMs || endMs - startMs > 26 * 60 * MINUTE_MS ||
    Math.abs(latDeg) > 90 ||
    !Number.isFinite(new Date(startMs).getTime()) ||
    !Number.isFinite(new Date(endMs).getTime())
  ) {
    return null;
  }
  const above = (ms: number) => solarPosition(latDeg, lonDeg, ms).isDaylight;
  const elevation = (ms: number) => solarPosition(latDeg, lonDeg, ms).elevationDeg;
  const refine = (a: number, b: number, rising: boolean) => {
    while (b - a > 1000) {
      const mid = (a + b) / 2;
      if (above(mid) === rising) b = mid;
      else a = mid;
    }
    return Math.round((a + b) / 2);
  };
  const step = 10 * 60_000;
  const sample = (time: number) => ({ time, elevation: elevation(time) });
  const samples = [sample(startMs - step), sample(startMs)];
  for (let t = startMs + step; t < endMs; t += step) samples.push(sample(t));
  samples.push(sample(endMs), sample(endMs + step));
  const sampledCount = samples.length;
  for (let i = 1; i < sampledCount - 1; i++) {
    const previous = samples[i - 1]!, current = samples[i]!, next = samples[i + 1]!;
    const maximum = current.elevation >= previous.elevation && current.elevation > next.elevation;
    const minimum = current.elevation <= previous.elevation && current.elevation < next.elevation;
    if (!maximum && !minimum) continue;
    let a = previous.time, b = next.time;
    while (b - a > 100) {
      const left = a + (b - a) / 3, right = b - (b - a) / 3;
      if ((elevation(left) < elevation(right)) === maximum) a = left;
      else b = right;
    }
    const extremum = (a + b) / 2;
    if (extremum > startMs && extremum < endMs) samples.push(sample(extremum));
  }
  samples.sort((a, b) => a.time - b.time);
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let prev = above(samples[1]!.time);
  for (let i = 2; i < samples.length - 1; i++) {
    const now = above(samples[i]!.time);
    if (now && !prev && sunrise === null) sunrise = refine(samples[i - 1]!.time, samples[i]!.time, true);
    if (!now && prev) sunset = refine(samples[i - 1]!.time, samples[i]!.time, false);
    prev = now;
  }
  return sunrise !== null && sunset !== null && sunset > sunrise ? { sunrise, sunset } : null;
}

/**
 * Relative clear-sky top-of-atmosphere horizontal solar flux factor (0..~1.03).
 */
export const solarFluxFactor = (latDeg: number, lonDeg: number, ms: number): number => {
  const pos = solarPosition(latDeg, lonDeg, ms);
  if (!Number.isFinite(pos.elevationDeg) || pos.elevationDeg <= 0) {
    return 0;
  }
  return Math.max(0, Math.sin(pos.elevationDeg * DEG_TO_RAD) * pos.distanceFactor);
};

/**
 * Evaluates whether a geographic coordinate is in daylight at any of the provided UTC timestamps.
 */
export const isDaylightAtTimestamps = (
  latDeg: number,
  lonDeg: number,
  timestampsMs: readonly number[],
  horizonDeg = DEFAULT_HORIZON_DEG
): boolean => {
  for (let index = 0; index < timestampsMs.length; index += 1) {
    const timestamp = timestampsMs[index];
    if (
      timestamp !== undefined &&
      Number.isFinite(timestamp) &&
      solarPosition(latDeg, lonDeg, timestamp, horizonDeg).isDaylight
    ) {
      return true;
    }
  }
  return false;
};
