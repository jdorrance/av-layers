// Sunlight reaching the ground, in W/m².
//
//   Clear sky   Meinel & Meinel (1976) direct-beam formula with Laue's (1970)
//               altitude correction and Kasten & Young's (1989) air mass;
//               diffuse sky light taken as 10 % of the direct beam
//               (see pveducation.org, "Calculation of Solar Insolation").
//   Clouds      Kasten & Czeplak (1980): total sunlight falls by
//               0.75 * cloud^3.4; the diffuse share rises from its clear-sky
//               value to 100 % under full overcast (no direct beam).
//   Surface     direct beam on the slope (zero when a ridge hides the sun),
//               plus diffuse light from the part of the sky the slope sees,
//               plus light reflected off the terrain it sees instead.
//
// This is a model of the sunlight that heats the ground, for comparing slopes
// and times of day; it ignores haze and smoke beyond a typical clear sky.

import type { SolarPosition } from './position.js';

const DEG = Math.PI / 180;
/** The solar constant as used in the Meinel formula, W/m². */
export const SOLAR_CONSTANT = 1353;
/** Share of sunlight the surrounding terrain reflects (grass, rock and scrub). */
export const ALBEDO = 0.2;

export interface Sky {
  /** Direct beam on a surface facing the sun. */
  dni: number;
  /** Diffuse sky light on flat open ground. */
  dhi: number;
  /** Total on flat open ground. */
  ghi: number;
}

export const DARK: Sky = { dni: 0, dhi: 0, ghi: 0 };

/** Relative optical air mass for a zenith angle in degrees (Kasten & Young 1989). */
export function airMass(zenithDeg: number): number {
  if (zenithDeg >= 90) return Number.POSITIVE_INFINITY;
  return 1 / (Math.cos(zenithDeg * DEG) + 0.50572 * (96.07995 - zenithDeg) ** -1.6364);
}

/** Clear-sky sunlight for a sun position at a ground altitude (m). */
export function clearSky(sun: Pick<SolarPosition, "elevationDeg" | "distanceFactor">, altitudeM: number): Sky {
  if (sun.elevationDeg <= 0) return DARK;
  const am = airMass(90 - sun.elevationDeg);
  const h = Math.max(0, altitudeM) / 1000;
  const dni = SOLAR_CONSTANT * sun.distanceFactor * ((1 - 0.14 * h) * 0.7 ** (am ** 0.678) + 0.14 * h);
  const dhi = 0.1 * dni;
  return { dni, dhi, ghi: dni * Math.sin(sun.elevationDeg * DEG) + dhi };
}

/** Dims a clear sky for a cloud cover fraction (0-1). */
export function withClouds(clear: Sky, sunElevationDeg: number, cloudFraction: number): Sky {
  if (clear.ghi <= 0) return DARK;
  const c = Math.min(1, Math.max(0, cloudFraction));
  const ghi = clear.ghi * (1 - 0.75 * c ** 3.4);
  const clearShare = clear.dhi / clear.ghi;
  const dhi = ghi * (clearShare + (1 - clearShare) * c * c);
  const sinEl = Math.sin(sunElevationDeg * DEG);
  return { dni: sinEl > 0 ? (ghi - dhi) / sinEl : 0, dhi, ghi };
}

/**
 * Sunlight on a surface with unit normal n (east, north, up) and sky-view
 * factor svf, for a sun direction s. `lit` is 1 in sunshine, 0 in a ridge's
 * shadow (fractions soften the shadow's edge).
 */
export function onSurface(sky: Sky, s: readonly [number, number, number], nx: number, ny: number, nz: number, svf: number, lit: number): number {
  const cos = nx * s[0] + ny * s[1] + nz * s[2];
  const direct = cos > 0 ? sky.dni * cos * lit : 0;
  return direct + sky.dhi * svf + ALBEDO * sky.ghi * (1 - svf);
}

/** Softness of a ridge shadow's edge, degrees of sun elevation (about the sun's own width, doubled). */
export const SHADOW_EDGE_DEG = 1;

/** 1 when the sun is clearly above the local horizon, 0 when clearly below, smooth in between. */
export function litFraction(sunElevationDeg: number, horizonDeg: number): number {
  const t = (sunElevationDeg - horizonDeg) / SHADOW_EDGE_DEG + 0.5;
  return t <= 0 ? 0 : t >= 1 ? 1 : t;
}

/** Neighbouring horizon directions and the weight of the second, for a sun azimuth. */
export function azimuthWeights(azimuthDeg: number, count: number): { i0: number; i1: number; w: number } {
  const step = 360 / count;
  const a = (((azimuthDeg % 360) + 360) % 360) / step;
  const i0 = Math.floor(a) % count;
  return { i0, i1: (i0 + 1) % count, w: a - Math.floor(a) };
}
