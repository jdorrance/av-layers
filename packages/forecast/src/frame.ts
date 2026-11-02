import {
  getBit,
  LIFT_METHOD_PARAMETERS,
  PRECIPITATION_METHOD_PARAMETERS,
   prepareGridGeometry,
  STATUS_NO_LIFT,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  type CoverageMask,
  type LayerId
} from '@av/contracts';
import { createGridDaylightTester } from '@av/solar';
import {
  deriveColumn,
  precipitationRateStatus,
  type ColumnDerivationOptions
} from './science.js';
import type { GridField } from './sampler.js';
import type { NormalizedFrame } from './inputs.js';

const { kelvinOffset: KELVIN_OFFSET, pascalsPerHectopascal: PA_PER_HPA } = LIFT_METHOD_PARAMETERS;

export interface DeriveFrameOptions extends ColumnDerivationOptions {
  /**
   * When true (default), cells that are in darkness across the trailing flux/precipitation
   * window and valid time skip column physics and precipitation evaluation.
   */
  readonly daylightOnly?: boolean;
  /**
   * Minimum solar elevation angle in degrees considered daylight (default: -0.833°).
   */
  readonly minimumSolarElevationDeg?: number;
  /**
   * Minimum valid liquid-water-equivalent precipitation rate in mm/h (default: 0).
   */
  readonly minimumRateMmPerHour?: number;
}

function field(mask: CoverageMask): GridField {
  const size = mask.grid.width * mask.grid.height;
  return { values: new Float32Array(size), flags: new Uint8Array(size).fill(STATUS_OUTSIDE) };
}

const buildDaylightTimestampsMs = (frame: NormalizedFrame): readonly number[] => {
  if (typeof frame.validAt !== 'string') {
    return [];
  }
  const endMs = Date.parse(frame.validAt);
  if (!Number.isFinite(endMs)) {
    return [];
  }
  const startRaw = frame.intervals?.fluxWindow?.start;
  const startMs = typeof startRaw === 'string' ? Date.parse(startRaw) : NaN;
  if (Number.isFinite(startMs) && startMs < endMs) {
    return [startMs, 0.5 * (startMs + endMs), endMs];
  }
  return [endMs];
};

export function deriveFrame(
  frame: NormalizedFrame,
  mask: CoverageMask,
  options?: DeriveFrameOptions
): Record<LayerId, GridField> {
  const result = {
    'usable-lift-msl': field(mask),
    'usable-lift-agl': field(mask),
    'precip-rate': field(mask)
  };
  const read = (values: Float32Array, missing: Uint8Array, i: number): number =>
    missing[i] ? NaN : values[i];
  const levels = Array.from({ length: frame.pressureLevelsHpa.length }, () => ({
    heightM: NaN,
    temperatureC: NaN
  }));

  const daylightOnly = options?.daylightOnly ?? true;
  const minimumSolarElevationDeg =
    options?.minimumSolarElevationDeg ?? LIFT_METHOD_PARAMETERS.minimumSolarElevationDeg;
  const minimumRateMmPerHour =
    options?.minimumRateMmPerHour ?? PRECIPITATION_METHOD_PARAMETERS.minimumRateMmPerHour;

  const timestampsMs = daylightOnly ? buildDaylightTimestampsMs(frame) : [];
  const isDaylight =
    timestampsMs.length === 0
      ? () => true
      : mask.grid.kind === 'regular-latlon'
        ? createGridDaylightTester(mask.grid, timestampsMs, minimumSolarElevationDeg)
        : (() => {
            const geom = prepareGridGeometry(mask.grid);
            return createGridDaylightTester(
              {
                kind: 'projected',
                width: mask.grid.width,
                height: mask.grid.height,
                gridToGeographic: (col, row) => geom.gridToGeographic(col, row)
              },
              timestampsMs,
              minimumSolarElevationDeg
            );
          })();

  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i];
    if (!getBit(mask.output, index) && !getBit(mask.halo, index)) {
      throw new Error('Acquisition returned inactive index');
    }
    const terrain = read(frame.terrainM, frame.missing.terrain, i);

    if (!isDaylight(index)) {
      const finiteTerrain = Number.isFinite(terrain);
      result['usable-lift-msl'].values[index] = finiteTerrain ? terrain : NaN;
      result['usable-lift-msl'].flags[index] = finiteTerrain ? STATUS_NO_LIFT : STATUS_UNAVAILABLE;
      result['usable-lift-agl'].values[index] = finiteTerrain ? 0 : NaN;
      result['usable-lift-agl'].flags[index] = finiteTerrain ? STATUS_NO_LIFT : STATUS_UNAVAILABLE;
      result['precip-rate'].values[index] = NaN;
      result['precip-rate'].flags[index] = STATUS_UNAVAILABLE;
      continue;
    }

    const pressure =
      read(frame.surfacePressurePa, frame.missing.surfacePressure, i) / PA_PER_HPA;
    let levelCount = 0;
    for (let j = 0; j < frame.pressureLevelsHpa.length; j++) {
      const p = frame.pressureLevelsHpa[j];
      const heightM = read(frame.hgtM[j], frame.missing.hgt[j], i);
      if (p >= pressure || (Number.isFinite(heightM) && heightM <= terrain)) continue;
      const level = levels[levelCount++];
      level.heightM = heightM;
      level.temperatureC = read(frame.tempK[j], frame.missing.temp[j], i) - KELVIN_OFFSET;
    }
    const lift = deriveColumn(
      {
        terrainM: terrain,
        surfaceTemperatureC: read(frame.temp2mK, frame.missing.temp2m, i) - KELVIN_OFFSET,
        surfacePressureHpa: pressure,
        humidity: {
          specificHumidityKgKg: read(
            frame.specificHumidity2mKgKg,
            frame.missing.humidity2m,
            i
          )
        },
        sensibleHeatFluxWm2: read(
          frame.sensibleHeatFluxWm2,
          frame.missing.sensibleHeatFlux,
          i
        ),
        latentHeatFluxWm2: read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i),
        pblHeightM: read(frame.pblHeightM, frame.missing.pbl, i),
        levels
      },
      levelCount,
      options
    );
    result['usable-lift-msl'].values[index] = lift.msl.value ?? NaN;
    result['usable-lift-msl'].flags[index] = lift.msl.flags;
    result['usable-lift-agl'].values[index] = lift.agl.value ?? NaN;
    result['usable-lift-agl'].flags[index] = lift.agl.flags;
    const rain = read(frame.precipitationMmPerHour, frame.missing.precipitation, i);
    const rainStatus = precipitationRateStatus(rain, minimumRateMmPerHour);
    result['precip-rate'].values[index] = rainStatus === STATUS_UNAVAILABLE ? NaN : rain;
    result['precip-rate'].flags[index] = rainStatus;
  }
  return result;
}
