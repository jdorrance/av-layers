import { LIFT_METHOD_PARAMETERS } from '@av/contracts';
import { saturationVaporPressureHpa } from '@av/thermodynamics';
import type { ColumnInput } from '@av/soaring';
import type { NormalizedFrame } from './inputs.js';

const { kelvinOffset, pascalsPerHectopascal, waterDryAirMolarMassRatio: epsilon, gribQuantizationRelativeHumidityLimit } = LIFT_METHOD_PARAMETERS;

export interface NativeColumnScratch extends ColumnInput {
  humidity: { specificHumidityKgKg: number };
  levels: { heightM: number; temperatureC: number }[];
}

export function createNativeColumnScratch(maxLevels: number): NativeColumnScratch {
  return {
    terrainM: NaN,
    surfaceTemperatureC: NaN,
    surfacePressureHpa: NaN,
    humidity: { specificHumidityKgKg: NaN },
    sensibleHeatFluxWm2: NaN,
    latentHeatFluxWm2: NaN,
    levels: Array.from({ length: maxLevels }, () => ({ heightM: NaN, temperatureC: NaN }))
  };
}

function readSurfaceSpecificHumidityKgKg(frame: NormalizedFrame, i: number): number {
  if (frame.missing.humidity2m[i]) return NaN;
  const specificHumidityKgKg = frame.specificHumidity2mKgKg[i]!;
  if (!Number.isFinite(specificHumidityKgKg) || specificHumidityKgKg <= 0 || specificHumidityKgKg >= 1) return specificHumidityKgKg;
  if (frame.missing.surfacePressure[i] || frame.missing.temp2m[i]) return specificHumidityKgKg;
  const pressure = frame.surfacePressurePa[i]! / pascalsPerHectopascal;
  const surfaceTemperatureC = frame.temp2mK[i]! - kelvinOffset;
  if (!Number.isFinite(pressure) || pressure <= 0 || !Number.isFinite(surfaceTemperatureC)) return specificHumidityKgKg;
  const es = saturationVaporPressureHpa(surfaceTemperatureC);
  if (!Number.isFinite(es) || es <= 0 || es >= pressure) return specificHumidityKgKg;
  const r = specificHumidityKgKg / (1 - specificHumidityKgKg);
  const e = pressure * r / (epsilon + r);
  if (e > es && e <= es * gribQuantizationRelativeHumidityLimit) {
    const rSat = epsilon * es / (pressure - es);
    return rSat / (1 + rSat);
  }
  return specificHumidityKgKg;
}

export function readNativeColumn(frame: NormalizedFrame, i: number, scratch: NativeColumnScratch): number {
  const read = (values: Float32Array, missing: Uint8Array): number => missing[i] ? NaN : values[i]!;
  const terrain = read(frame.terrainM, frame.missing.terrain);
  const pressure = read(frame.surfacePressurePa, frame.missing.surfacePressure) / pascalsPerHectopascal;
  const totalLevels = frame.pressurePa !== undefined ? frame.pressurePa.length : frame.pressureLevelsHpa.length;
  if (totalLevels > scratch.levels.length) throw new RangeError('Native column scratch is too small');
  let count = 0;
  for (let j = 0; j < totalLevels; j++) {
    const p = frame.pressurePa !== undefined
      ? read(frame.pressurePa[j]!, frame.missing.pressure[j]!) / pascalsPerHectopascal
      : frame.pressureLevelsHpa[j]!;
    const heightM = read(frame.hgtM[j]!, frame.missing.hgt[j]!);
    const validPressure = Number.isFinite(p) && p > 0;
    if ((validPressure && p >= pressure) || (Number.isFinite(heightM) && heightM <= terrain)) continue;
    const level = scratch.levels[count++]!;
    level.heightM = validPressure ? heightM : NaN;
    level.temperatureC = read(frame.tempK[j]!, frame.missing.temp[j]!) - kelvinOffset;
  }
  scratch.terrainM = terrain;
  scratch.surfacePressureHpa = pressure;
  scratch.surfaceTemperatureC = read(frame.temp2mK, frame.missing.temp2m) - kelvinOffset;
  scratch.humidity.specificHumidityKgKg = readSurfaceSpecificHumidityKgKg(frame, i);
  scratch.sensibleHeatFluxWm2 = read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux);
  scratch.latentHeatFluxWm2 = read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux);
  return count;
}
