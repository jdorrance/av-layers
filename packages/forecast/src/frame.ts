import { getBit, LIFT_METHOD_PARAMETERS, STATUS_OUTSIDE, type CoverageMask, type LayerId } from '@av/contracts';
import { deriveColumn, precipitationRateStatus } from './science.js';
import type { GridField } from './sampler.js';
import type { NormalizedFrame } from './inputs.js';

const { kelvinOffset: KELVIN_OFFSET, pascalsPerHectopascal: PA_PER_HPA } = LIFT_METHOD_PARAMETERS;

function field(mask: CoverageMask): GridField {
  const size = mask.grid.width * mask.grid.height;
  return { values: new Float32Array(size), flags: new Uint8Array(size).fill(STATUS_OUTSIDE) };
}

export function deriveFrame(frame: NormalizedFrame, mask: CoverageMask): Record<LayerId, GridField> {
  const result = { 'usable-lift-msl': field(mask), 'usable-lift-agl': field(mask), 'precip-rate': field(mask) };
  const read = (values: Float32Array, missing: Uint8Array, i: number): number => missing[i] ? NaN : values[i];
  const levels = Array.from({ length: frame.pressureLevelsHpa.length }, () => ({ heightM: NaN, temperatureC: NaN }));
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i];
    if (!getBit(mask.output, index) && !getBit(mask.halo, index)) throw new Error('Acquisition returned inactive index');
    const pressure = read(frame.surfacePressurePa, frame.missing.surfacePressure, i) / PA_PER_HPA;
    const terrain = read(frame.terrainM, frame.missing.terrain, i);
    let levelCount = 0;
    for (let j = 0; j < frame.pressureLevelsHpa.length; j++) {
      const p = frame.pressureLevelsHpa[j];
      const heightM = read(frame.hgtM[j], frame.missing.hgt[j], i);
      if (p >= pressure || (Number.isFinite(heightM) && heightM <= terrain)) continue;
      const level = levels[levelCount++];
      level.heightM = heightM;
      level.temperatureC = read(frame.tempK[j], frame.missing.temp[j], i) - KELVIN_OFFSET;
    }
    const lift = deriveColumn({
      terrainM: terrain,
      surfaceTemperatureC: read(frame.temp2mK, frame.missing.temp2m, i) - KELVIN_OFFSET,
      surfacePressureHpa: pressure,
      humidity: { specificHumidityKgKg: read(frame.specificHumidity2mKgKg, frame.missing.humidity2m, i) },
      sensibleHeatFluxWm2: read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux, i),
      latentHeatFluxWm2: read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i),
      pblHeightM: read(frame.pblHeightM, frame.missing.pbl, i),
      levels
    }, levelCount);
    result['usable-lift-msl'].values[index] = lift.msl.value ?? NaN;
    result['usable-lift-msl'].flags[index] = lift.msl.flags;
    result['usable-lift-agl'].values[index] = lift.agl.value ?? NaN;
    result['usable-lift-agl'].flags[index] = lift.agl.flags;
    const rain = read(frame.precipitationMmPerHour, frame.missing.precipitation, i);
    result['precip-rate'].values[index] = rain;
    result['precip-rate'].flags[index] = precipitationRateStatus(rain);
  }
  return result;
}

