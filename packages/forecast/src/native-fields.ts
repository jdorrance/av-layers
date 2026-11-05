/** Map native arrays to sparse point channels and fixed-width profile records. */
import {
  MAX_GRID_CELLS, sparseCoverageLookup, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID,
  SUPPORT_CUMULUS, SUPPORT_OVERDEVELOPED, SUPPORT_CLOUD_CAPPED,
  type CoverageMask, type LayerId, type SparseCoverage
} from '@av/contracts';
import { deriveNativeColumnDiagnostics, type NativeDiagnosticInput, type NativeDiagnosticLevel } from '@av/soaring';
import { dewPointFromSpecificHumidityC, dewpointFromTempAndRhC } from '@av/thermodynamics';
import type { AuxField, AuxSurfaceId, NormalizedFrame } from './inputs.js';
import type { GridField } from './sampler.js';
import { profileRecordBytes, writeProfileRecord, type ProfileLevelInput } from './profile-pack.js';
import { readSurfaceSpecificHumidityKgKg } from './column-input.js';

const number = (n: number): number | null => Number.isFinite(n) ? n : null;
const at = (field: AuxField | undefined, i: number): number | null => field && !field.missing[i] ? number(field.values[i]!) : null;
const read = (values: Float32Array, missing: Uint8Array, i: number): number => missing[i] ? NaN : values[i]!;

type NativeLevel = NativeDiagnosticLevel & { pressureHpa: number; uWindMps: number | null; vWindMps: number | null; omegaPaS: number | null };

function columnReader(frame: NormalizedFrame, includeLevels = true) {
  const maxLevels = frame.hgtM.length;
  const levels: NativeLevel[] = Array.from({ length: maxLevels }, () => ({
    heightM: NaN, temperatureC: NaN, pressureHpa: NaN, dewPointC: null,
    uMps: null, vMps: null, uWindMps: null, vWindMps: null, omegaPaS: null
  }));
  const input: NativeDiagnosticInput = { terrainM: NaN, surfaceTemperatureC: NaN, levels };
  const readColumn = (i: number): number => {
    const terrain = read(frame.terrainM, frame.missing.terrain, i);
    const pressure = read(frame.surfacePressurePa, frame.missing.surfacePressure, i) / 100;
    const temperature = read(frame.temp2mK, frame.missing.temp2m, i) - 273.15;
    const aux = (id: AuxSurfaceId) => at(frame.auxSurface?.[id], i);
    const dewpoint = dewPointFromSpecificHumidityC(readSurfaceSpecificHumidityKgKg(frame, i), pressure);
    input.terrainM = terrain; input.surfaceTemperatureC = temperature; input.surfaceDewPointC = number(dewpoint); input.surfacePressureHpa = number(pressure);
    input.sensibleHeatFluxWm2 = number(read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux, i));
    input.latentHeatFluxWm2 = number(read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i));
    input.pblHeightM = aux('pblHeightM'); input.wind10mU = aux('u10mMps'); input.wind10mV = aux('v10mMps');
    let count = 0;
    for (let j = 0; includeLevels && j < maxLevels; j++) {
      const p = frame.pressurePa ? read(frame.pressurePa[j]!, frame.missing.pressure![j]!, i) / 100 : frame.pressureLevelsHpa![j]!;
      const height = read(frame.hgtM[j]!, frame.missing.hgt[j]!, i);
      if ((Number.isFinite(p) && p >= pressure) || (Number.isFinite(height) && height <= terrain)) continue;
      const t = read(frame.tempK[j]!, frame.missing.temp[j]!, i) - 273.15;
      const q = at(frame.auxLevels?.spfhKgKg?.[j], i), relativeHumidity = at(frame.auxLevels?.rhPercent?.[j], i);
      const td = q !== null ? dewPointFromSpecificHumidityC(q, p) : relativeHumidity !== null ? dewpointFromTempAndRhC(t, relativeHumidity) : NaN;
      const u = at(frame.auxLevels?.uWindMps?.[j], i), v = at(frame.auxLevels?.vWindMps?.[j], i);
      const level = levels[count++]!;
      level.heightM = height; level.temperatureC = t; level.pressureHpa = p; level.dewPointC = number(td);
      level.uMps = u; level.vMps = v; level.uWindMps = u; level.vWindMps = v; level.omegaPaS = at(frame.auxLevels?.omegaPaS?.[j], i);
    }
    return count;
  };
  return { input, read: readColumn };
}

const surfaceChannels = {
  'pbl-height-agl': 'pblHeightM', 'cape-jkg': 'capeJkg',
  'cloud-cover-total': 'cloudTotalPct', 'cloud-cover-low': 'cloudLowPct',
  'mslp-hpa': 'mslpPa', 'wind-10m-u': 'u10mMps', 'wind-10m-v': 'v10mMps', 'wind-gust-10m': 'gust10mMps'
} as const satisfies Partial<Record<LayerId, AuxSurfaceId>>;

export function prepareNativeFields(frame: NormalizedFrame, mask: CoverageMask, layers: readonly LayerId[], coverage?: SparseCoverage) {
  const size = coverage ? coverage.offsets[coverage.offsets.length - 1]! : mask.grid.width * mask.grid.height;
  const fields: Partial<Record<LayerId, GridField>> = {};
  for (const layer of layers) fields[layer] = { values: new Float32Array(size).fill(NaN), flags: new Uint8Array(size).fill(STATUS_OUTSIDE), ...(coverage ? { coverage } : {}) };
  const wantsColumn = layers.some(layer => ['thermal-velocity', 'thermal-top-msl', 'surface-lcl-msl', 'bl-mean-wind-u', 'bl-mean-wind-v'].includes(layer));
  const readColumn = columnReader(frame, wantsColumn);
  const values: Partial<Record<LayerId, number | null>> = {};
  function write(i: number, daylight: boolean) {
    const index = frame.activeIndices[i]!, slot = coverage ? sparseCoverageLookup(coverage, index % mask.grid.width, Math.floor(index / mask.grid.width))?.offset : index;
    if (slot === undefined) return;
    const count = readColumn.read(i), input = readColumn.input;
    input.daylight = daylight;
    const diagnostic = wantsColumn ? deriveNativeColumnDiagnostics(input, count) : undefined;
    const support = diagnostic ? (diagnostic.cumulus ? SUPPORT_CUMULUS : 0) | (diagnostic.overdeveloped ? SUPPORT_OVERDEVELOPED : 0) | (diagnostic.cloudCapped ? SUPPORT_CLOUD_CAPPED : 0) : 0;
    values['sfc-temp-c'] = number(input.surfaceTemperatureC); values['sfc-dewpoint-c'] = input.surfaceDewPointC ?? null;
    values['sensible-heat-flux'] = input.sensibleHeatFluxWm2 ?? null; values['latent-heat-flux'] = input.latentHeatFluxWm2 ?? null;
    values['thermal-velocity'] = diagnostic?.thermalVelocityMps ?? null; values['thermal-top-msl'] = diagnostic?.thermalTopM ?? null;
    values['surface-lcl-msl'] = diagnostic?.surfaceLclM ?? null;
    values['bl-mean-wind-u'] = diagnostic?.blMeanWindU ?? null; values['bl-mean-wind-v'] = diagnostic?.blMeanWindV ?? null;
    for (const layer of layers) {
      const source = surfaceChannels[layer as keyof typeof surfaceChannels];
      let value = source ? at(frame.auxSurface?.[source], i) : values[layer] ?? null;
      if (layer === 'mslp-hpa' && value !== null) value /= 100;
      const field = fields[layer]!;
      field.values[slot] = value ?? NaN;
      field.flags[slot] = value === null || !Number.isFinite(value) ? STATUS_UNAVAILABLE : STATUS_VALID | (layer.startsWith('thermal-') ? support : 0);
    }
    return support;
  }
  return { fields, write };
}

/** Stream complete native columns through one borrowed record and a grid-to-active index. */
export function prepareNativeProfiles(frame: NormalizedFrame, coverage: SparseCoverage) {
  const cells = frame.grid.width * frame.grid.height;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > MAX_GRID_CELLS || coverage.width !== frame.grid.width
    || coverage.height !== frame.grid.height || coverage.wrapLongitude !== frame.grid.wrapLongitude) throw new RangeError('Invalid native profile grid');
  const ordinals = new Int32Array(cells).fill(-1);
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i]!;
    if (index >= cells || (i > 0 && index <= frame.activeIndices[i - 1]!)) throw new RangeError('Invalid native profile active indices');
    ordinals[index] = i;
  }
  const record = new Uint8Array(profileRecordBytes(frame.hgtM.length)), readColumn = columnReader(frame);
  const scratch = Array.from({ length: frame.hgtM.length }, (): { -readonly [Key in keyof ProfileLevelInput]: ProfileLevelInput[Key] } => ({
    pressureHpa: null, heightM: null, temperatureC: null, dewPointC: null, uWindMps: null, vWindMps: null, omegaPaS: null
  }));
  const profile = { modelTerrainM: null as number | null, surfacePressureHpa: null as number | null,
    status: 'unavailable' as 'valid' | 'unavailable', levels: [] as ProfileLevelInput[] };
  return {
    byteLength: ordinals.byteLength + record.byteLength,
    readRecord(index: number): Uint8Array {
      if (!Number.isSafeInteger(index) || index < 0 || index >= cells || ordinals[index]! < 0) throw new RangeError('Native profile cell was not acquired');
      const count = readColumn.read(ordinals[index]!), input = readColumn.input;
      profile.modelTerrainM = number(input.terrainM); profile.surfacePressureHpa = input.surfacePressureHpa ?? null;
      profile.status = profile.modelTerrainM === null ? 'unavailable' : 'valid';
      profile.levels.length = count;
      for (let j = 0; j < profile.levels.length; j++) {
        const level = input.levels[j] as NativeLevel, target = scratch[j]!;
        target.pressureHpa = number(level.pressureHpa); target.heightM = number(level.heightM); target.temperatureC = number(level.temperatureC);
        target.dewPointC = level.dewPointC ?? null; target.uWindMps = level.uWindMps; target.vWindMps = level.vWindMps; target.omegaPaS = level.omegaPaS;
        profile.levels[j] = target;
      }
      writeProfileRecord(record, profile);
      return record;
    }
  };
}
