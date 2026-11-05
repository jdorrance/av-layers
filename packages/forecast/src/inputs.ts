import {
  LAYER_IDS,
  NORMALIZED_INPUTS,
  sameGrid,
  type Grid,
  type LayerId,
  type VerticalCoordinateKind
} from '@av/contracts';

export const AUX_SURFACE_IDS = ['mslpPa', 'u10mMps', 'v10mMps', 'gust10mMps', 'pblHeightM', 'capeJkg', 'cloudTotalPct', 'cloudLowPct'] as const;
export const AUX_LEVEL_IDS = ['spfhKgKg', 'rhPercent', 'uWindMps', 'vWindMps', 'omegaPaS'] as const;
export type AuxSurfaceId = typeof AUX_SURFACE_IDS[number];
export type AuxLevelId = typeof AUX_LEVEL_IDS[number];
function auxiliaryUnits<const Id extends keyof typeof NORMALIZED_INPUTS>(ids: readonly Id[]) {
  return Object.fromEntries(ids.map(id => [id, NORMALIZED_INPUTS[id].units])) as { [Key in Id]: (typeof NORMALIZED_INPUTS)[Key]['units'] };
}
export const AUX_SURFACE_UNITS = auxiliaryUnits(AUX_SURFACE_IDS);
export const AUX_LEVEL_UNITS = auxiliaryUnits(AUX_LEVEL_IDS);
export interface AuxField { values: Float32Array; missing: Uint8Array }
export type AuxSurface = Partial<Record<AuxSurfaceId, AuxField>>;
export type AuxLevels = Partial<Record<AuxLevelId, readonly AuxField[]>>;

/**
 * Provider-independent arrays in the declared field units, compacted to activeIndices;
 * missingness is explicit.
 *
 * Vertical profiles use one of two explicit representations declared by
 * `product.capabilities.verticalCoordinate`:
 * - `'isobaric'`: shared pressures (`pressureLevelsHpa`).
 * - `'model-levels'`: per-column pressures (`pressurePa` + `missing.pressure`).
 *
 * Precipitation arrays (`precipitationMmPerHour` + `missing.precipitation`) are required only
 * when `'precip-rate'` is included in the product's layers.
 */
interface FrameFields {
  cycle: string;
  hour: number;
  validAt: string;
  capturedAt: string;
  grid: Grid;
  activeIndices: Uint32Array;
  terrainM: Float32Array;
  surfacePressurePa: Float32Array;
  temp2mK: Float32Array;
  specificHumidity2mKgKg: Float32Array;
  sensibleHeatFluxWm2: Float32Array;
  latentHeatFluxWm2: Float32Array;
  precipitationMmPerHour?: Float32Array;
  hgtM: Float32Array[];
  tempK: Float32Array[];
  /** Canonical units are keyed by AUX_SURFACE_UNITS/AUX_LEVEL_UNITS; winds are Earth-relative. */
  auxSurface?: AuxSurface;
  auxLevels?: AuxLevels;
  missing: {
    terrain: Uint8Array;
    surfacePressure: Uint8Array;
    temp2m: Uint8Array;
    humidity2m: Uint8Array;
    sensibleHeatFlux: Uint8Array;
    latentHeatFlux: Uint8Array;
    precipitation?: Uint8Array;
    hgt: Uint8Array[];
    temp: Uint8Array[];
  };
  intervals: {
    profileTime: string;
    fluxWindow: { start: string; end: string };
    precipitationWindow?: { start: string; end: string };
    fluxSourceWindow: { start: string; end: string };
    precipitationSourceWindow?: { start: string; end: string };
    usedCompanion: boolean;
  };
  receipt: Record<string, unknown>;
}

export interface IsobaricFrame extends FrameFields {
  pressureLevelsHpa: readonly number[];
  pressurePa?: never;
  missing: FrameFields['missing'] & { pressure?: never };
}

export interface ModelLevelFrame extends FrameFields {
  pressurePa: Float32Array[];
  pressureLevelsHpa?: never;
  missing: FrameFields['missing'] & { pressure: Uint8Array[] };
}

export type NormalizedFrame = IsobaricFrame | ModelLevelFrame;

export function validateNormalizedFrame(
  frame: NormalizedFrame,
  active: Uint32Array,
  grid: Grid,
  maxLevels: number,
  layers: readonly LayerId[] = LAYER_IDS,
  verticalCoordinate?: VerticalCoordinateKind
): void {
  if (
    !(frame.activeIndices instanceof Uint32Array) ||
    !active.length ||
    !sameGrid(frame.grid, grid) ||
    frame.activeIndices.length !== active.length ||
    frame.activeIndices.some((value, i) => value !== active[i])
  ) {
    throw new Error('Normalized input grid or active-index identity mismatch');
  }

  if (!Number.isSafeInteger(maxLevels) || maxLevels < 1) {
    throw new Error('Unsupported normalized vertical axis');
  }

  const hasSharedIsobaric = frame.pressureLevelsHpa !== undefined;
  const hasPerColumnPressure = frame.pressurePa !== undefined;
  if (hasSharedIsobaric === hasPerColumnPressure) {
    throw new Error('Unsupported normalized vertical axis');
  }
  if (
    (verticalCoordinate === 'isobaric' && !hasSharedIsobaric) ||
    (verticalCoordinate === 'model-levels' && !hasPerColumnPressure)
  ) {
    throw new Error('Unsupported normalized vertical axis');
  }

  let levelCount = 0;
  if (hasSharedIsobaric) {
    const levels = frame.pressureLevelsHpa!;
    if (
      !Array.isArray(levels) ||
      !levels.length ||
      levels.length > maxLevels ||
      frame.missing.pressure !== undefined ||
      levels.some((p, i) => !Number.isFinite(p) || p <= 0 || (i > 0 && p >= levels[i - 1]!))
    ) {
      throw new Error('Unsupported normalized vertical axis');
    }
    levelCount = levels.length;
  } else {
    const pressurePa = frame.pressurePa!;
    const missingPressure = frame.missing.pressure;
    if (
      !Array.isArray(pressurePa) ||
      !pressurePa.length ||
      pressurePa.length > maxLevels ||
      !Array.isArray(missingPressure) ||
      missingPressure.length !== pressurePa.length
    ) {
      throw new Error('Unsupported normalized vertical axis');
    }
    levelCount = pressurePa.length;
  }

  const requiresPrecipitation = layers.includes('precip-rate');

  const fields = [
    frame.terrainM, frame.surfacePressurePa, frame.temp2mK, frame.specificHumidity2mKgKg,
    frame.sensibleHeatFluxWm2, frame.latentHeatFluxWm2
  ];
  const missing = [
    frame.missing.terrain, frame.missing.surfacePressure, frame.missing.temp2m, frame.missing.humidity2m,
    frame.missing.sensibleHeatFlux, frame.missing.latentHeatFlux
  ];

  if (requiresPrecipitation || frame.precipitationMmPerHour !== undefined || frame.missing.precipitation !== undefined) {
    if (!(frame.precipitationMmPerHour instanceof Float32Array) || !(frame.missing.precipitation instanceof Uint8Array)) {
      throw new Error('Normalized input array dimensions or types mismatch');
    }
    fields.push(frame.precipitationMmPerHour);
    missing.push(frame.missing.precipitation);
  }

  if ([frame.hgtM, frame.tempK, frame.missing.hgt, frame.missing.temp].some(values => !Array.isArray(values) || values.length !== levelCount)) {
    throw new Error('Normalized input array dimensions mismatch');
  }

  const allFields = [
    ...fields,
    ...(frame.pressurePa ?? []),
    ...frame.hgtM,
    ...frame.tempK
  ];
  const allMissing = [
    ...missing,
    ...(frame.missing.pressure ?? []),
    ...frame.missing.hgt,
    ...frame.missing.temp
  ];

  for (const [fields, units, profile] of [
    [frame.auxSurface, AUX_SURFACE_UNITS, false], [frame.auxLevels, AUX_LEVEL_UNITS, true]
  ] as const) {
    if (fields === undefined) continue;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Normalized auxiliary fields must be a map');
    for (const [name, value] of Object.entries(fields)) {
      if (!Object.hasOwn(units, name)) throw new Error(`Unsupported normalized auxiliary field ${name}`);
      const records = profile ? value as readonly AuxField[] : [value as AuxField];
      if (!Array.isArray(records) || (profile && records.length !== levelCount)) throw new Error('Normalized auxiliary level count mismatch');
      for (const record of records) {
        if (!record || typeof record !== 'object') throw new Error('Normalized auxiliary field is invalid');
        allFields.push(record.values); allMissing.push(record.missing);
      }
    }
  }

  for (let field = 0; field < allFields.length; field++) {
    const values = allFields[field];
    const flags = allMissing[field];
    if (
      !(values instanceof Float32Array) ||
      !(flags instanceof Uint8Array) ||
      values.length !== active.length ||
      flags.length !== active.length
    ) {
      throw new Error('Normalized input array dimensions or types mismatch');
    }
    for (let cell = 0; cell < active.length; cell++) {
      if ((flags[cell] !== 0 && flags[cell] !== 1) || (flags[cell] === 0 && !Number.isFinite(values[cell]))) {
        throw new Error('Normalized input has invalid missingness or unmasked nonfinite values');
      }
    }
  }
}
