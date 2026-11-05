import {
  getBit,
  gridSchema,
  LAYER_IDS,
  LIFT_METHOD_PARAMETERS,
  MAX_GRID_CELLS,
  PRECIPITATION_METHOD_PARAMETERS,
  STATUS_NO_LIFT,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  renderedLayers,
  type CoverageMask,
  type LayerId,
  type SparseCoverage
} from '@av/contracts';
import {
  buildIntervalDaylightTimestampsMs,
  createMaskDaylightTester
} from './daylight.js';
import {
  deriveColumn,
  precipitationRateStatus,
  type ColumnDerivationOptions
} from './science.js';
import type { GridField } from './sampler.js';
import { validateNormalizedFrame, type NormalizedFrame } from './inputs.js';
import type { DepthBranch } from '@av/soaring';
import { createNativeColumnScratch, readNativeColumn } from './column-input.js';
import { prepareNativeFields } from './native-fields.js';


export interface FrameDiagnostics {
  readonly ceilingMslM: Float32Array;
  readonly buoyancyM2S3: Float32Array;
  readonly branch: Uint8Array;
}

export const FRAME_BRANCH = Object.freeze({
  unavailable: 0,
  nonConvective: 1,
  parcelCrossing: 2,
  profileTop: 3,
  surfaceStable: 4,
  skippedDark: 5
} as const);

type FrameBranchCode = typeof FRAME_BRANCH[keyof typeof FRAME_BRANCH];

const branchCodes: Record<DepthBranch, FrameBranchCode> = {
  unavailable: FRAME_BRANCH.unavailable,
  'non-convective': FRAME_BRANCH.nonConvective,
  'parcel-crossing': FRAME_BRANCH.parcelCrossing,
  'profile-top': FRAME_BRANCH.profileTop,
  'surface-stable': FRAME_BRANCH.surfaceStable
};

export interface DeriveFrameOptions extends ColumnDerivationOptions {
  /**
   * Subset of layers to allocate and derive. When omitted, derives all layers
   * whose required inputs are present in `frame`.
   */
  readonly layers?: readonly LayerId[];
  /**
   * When true (default), dark cells skip convective column physics.
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
  readonly diagnostics?: FrameDiagnostics;
  readonly nativeCoverage?: SparseCoverage;
}

function field(mask: CoverageMask): GridField {
  const size = mask.grid.width * mask.grid.height;
  return { values: new Float32Array(size), flags: new Uint8Array(size).fill(STATUS_OUTSIDE) };
}

const frameViews = (frame: NormalizedFrame): ArrayBufferView[] => [
  frame.activeIndices,
  frame.terrainM,
  frame.surfacePressurePa,
  frame.temp2mK,
  frame.specificHumidity2mKgKg,
  frame.sensibleHeatFluxWm2,
  frame.latentHeatFluxWm2,
  ...(frame.precipitationMmPerHour ? [frame.precipitationMmPerHour] : []),
  ...frame.hgtM,
  ...frame.tempK,
  ...(frame.pressurePa ?? []),
  frame.missing.terrain,
  frame.missing.surfacePressure,
  frame.missing.temp2m,
  frame.missing.humidity2m,
  frame.missing.sensibleHeatFlux,
  frame.missing.latentHeatFlux,
  ...(frame.missing.precipitation ? [frame.missing.precipitation] : []),
  ...frame.missing.hgt,
  ...frame.missing.temp,
  ...(frame.missing.pressure ?? []),
  ...Object.values(frame.auxSurface ?? {}).flatMap(field => [field.values, field.missing]),
  ...Object.values(frame.auxLevels ?? {}).flatMap(levels => levels.flatMap(field => [field.values, field.missing]))
];

function validateDiagnostics(
  diagnostics: FrameDiagnostics,
  frame: NormalizedFrame,
  mask: CoverageMask
): void {
  const cells = mask.grid.width * mask.grid.height;
  const arrays = [diagnostics.ceilingMslM, diagnostics.buoyancyM2S3, diagnostics.branch];
  const types = [Float32Array, Float32Array, Uint8Array] as const;
  if (arrays.some((array, i) => !(array instanceof types[i]) || array.length !== cells)) {
    throw new Error('Diagnostics arrays must match the native grid and declared types');
  }
  const inputBuffers = new Set([...frameViews(frame), mask.output, mask.halo, mask.tiles].map(view => view.buffer));
  if (arrays.some(array => inputBuffers.has(array.buffer))) {
    throw new Error('Diagnostics arrays must not alias frame inputs');
  }
  if (arrays[0]!.buffer === arrays[1]!.buffer || arrays[0]!.buffer === arrays[2]!.buffer || arrays[1]!.buffer === arrays[2]!.buffer) {
    throw new Error('Diagnostics arrays must not alias each other');
  }
}

function resetDiagnostics(diagnostics: FrameDiagnostics): void {
  diagnostics.ceilingMslM.fill(NaN);
  diagnostics.buoyancyM2S3.fill(NaN);
  diagnostics.branch.fill(FRAME_BRANCH.unavailable);
}

function writeColumnDiagnostics(
  diagnostics: FrameDiagnostics,
  index: number,
  terrain: number,
  branch: DepthBranch,
  depthM: number | null,
  thermalVelocityMps: number | null
): void {
  const code = branchCodes[branch];
  if (branch === 'unavailable' || !Number.isFinite(terrain)) {
    return;
  }
  if (branch === 'non-convective' || branch === 'surface-stable') {
    diagnostics.ceilingMslM[index] = terrain;
    diagnostics.buoyancyM2S3[index] = 0;
    diagnostics.branch[index] = code;
    return;
  }
  if (depthM === null || thermalVelocityMps === null || !Number.isFinite(depthM) || depthM <= 0 || !Number.isFinite(thermalVelocityMps)) {
    return;
  }
  diagnostics.ceilingMslM[index] = terrain + depthM;
  diagnostics.buoyancyM2S3[index] = (thermalVelocityMps ** 3) / depthM;
  diagnostics.branch[index] = code;
}

export function deriveSelectedFrameDiagnostics(frame: NormalizedFrame, sourceIndices: Uint32Array): {
  diagnostics: FrameDiagnostics; flags: Uint8Array; bufferBytes: number;
} {
  const grid = gridSchema.parse(frame.grid), cells = grid.width * grid.height;
  if (!Number.isSafeInteger(cells) || cells > MAX_GRID_CELLS || !(sourceIndices instanceof Uint32Array) || !sourceIndices.length ||
      !(frame.activeIndices instanceof Uint32Array) || !frame.activeIndices.length) throw new RangeError('Invalid selected frame dimensions');
  const active = frame.activeIndices;
  for (let i = 0; i < active.length; i++) {
    if (active[i]! >= cells || (i > 0 && active[i]! <= active[i - 1]!)) throw new RangeError('Invalid frame active indices');
  }
  const levelCount = frame.pressurePa?.length ?? frame.pressureLevelsHpa?.length ?? 0;
  validateNormalizedFrame(frame, active, grid, levelCount, ['usable-lift-agl']);
  for (let i = 0; i < sourceIndices.length; i++) {
    const index = sourceIndices[i]!;
    if (index >= cells || (i > 0 && index <= sourceIndices[i - 1]!)) throw new RangeError('Invalid selected source indices');
    let lo = 0, hi = active.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (active[mid]! < index) lo = mid + 1; else hi = mid; }
    if (active[lo] !== index) throw new RangeError('Selected source index is not active');
  }
  const diagnostics: FrameDiagnostics = { ceilingMslM: new Float32Array(cells), buoyancyM2S3: new Float32Array(cells), branch: new Uint8Array(cells) };
  resetDiagnostics(diagnostics);
  const flags = new Uint8Array(cells).fill(STATUS_OUTSIDE), scratch = createNativeColumnScratch(levelCount);
  for (const index of sourceIndices) {
    let lo = 0, hi = active.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (active[mid]! < index) lo = mid + 1; else hi = mid; }
    const count = readNativeColumn(frame, lo, scratch), lift = deriveColumn(scratch, count);
    flags[index] = lift.agl.flags;
    writeColumnDiagnostics(diagnostics, index, scratch.terrainM, lift.branch, lift.depthM, lift.thermalVelocityMps);
  }
  return { diagnostics, flags, bufferBytes: diagnostics.ceilingMslM.byteLength + diagnostics.buoyancyM2S3.byteLength + diagnostics.branch.byteLength + flags.byteLength };
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
  return buildIntervalDaylightTimestampsMs(startMs, endMs);
};

export function deriveFrame(
  frame: NormalizedFrame,
  mask: CoverageMask,
  options?: DeriveFrameOptions
): Partial<Record<LayerId, GridField>> {
  const activeLayers: readonly LayerId[] =
    options?.layers ??
    (frame.precipitationMmPerHour instanceof Float32Array
      ? renderedLayers(LAYER_IDS)
      : (['usable-lift-msl', 'usable-lift-agl'] as const));

  const requiresLift = activeLayers.some(
    layer => layer === 'usable-lift-msl' || layer === 'usable-lift-agl'
  );
  const requiresPrecip = activeLayers.includes('precip-rate');
  const diagnostics = options?.diagnostics;
  if (diagnostics) {
    if (!requiresLift) {
      throw new Error('Diagnostics require a usable-lift layer; precipitation-only diagnostics are unsupported');
    }
    validateDiagnostics(diagnostics, frame, mask);
    resetDiagnostics(diagnostics);
  }
  if (
    requiresPrecip &&
    (!(frame.precipitationMmPerHour instanceof Float32Array) ||
      !(frame.missing.precipitation instanceof Uint8Array))
  ) {
    throw new Error('precip-rate layer requires precipitationMmPerHour and missing.precipitation');
  }

  const liftMsl = activeLayers.includes('usable-lift-msl') ? field(mask) : undefined;
  const liftAgl = activeLayers.includes('usable-lift-agl') ? field(mask) : undefined;
  const precipitation = requiresPrecip ? field(mask) : undefined;
  const result: Partial<Record<LayerId, GridField>> = {};
  if (liftMsl) result['usable-lift-msl'] = liftMsl;
  if (liftAgl) result['usable-lift-agl'] = liftAgl;
  if (precipitation) result['precip-rate'] = precipitation;
  const nativeLayers = activeLayers.filter(layer => !renderedLayers([layer]).length);
  const native = nativeLayers.length ? prepareNativeFields(frame, mask, nativeLayers, options?.nativeCoverage) : undefined;
  if (native) Object.assign(result, native.fields);

  const read = (values: Float32Array, missing: Uint8Array, i: number): number =>
    missing[i] ? NaN : values[i];

  const totalLevels = frame.pressurePa !== undefined ? frame.pressurePa.length : frame.pressureLevelsHpa.length;
  const column = createNativeColumnScratch(totalLevels);

  const daylightOnly = options?.daylightOnly ?? true;
  const minimumSolarElevationDeg =
    options?.minimumSolarElevationDeg ?? LIFT_METHOD_PARAMETERS.minimumSolarElevationDeg;
  const minimumRateMmPerHour =
    options?.minimumRateMmPerHour ?? PRECIPITATION_METHOD_PARAMETERS.minimumRateMmPerHour;

  const timestampsMs = daylightOnly ? buildDaylightTimestampsMs(frame) : [];
  const isDaylight = createMaskDaylightTester(
    mask.grid,
    timestampsMs,
    minimumSolarElevationDeg
  );

  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i];
    if (!getBit(mask.output, index) && !getBit(mask.halo, index)) {
      throw new Error('Acquisition returned inactive index');
    }
    const terrain = read(frame.terrainM, frame.missing.terrain, i);
    const daylight = isDaylight(index);
    const cloudSupport = native?.write(i, daylight) ?? 0;
    if (precipitation) {
      const rain = read(frame.precipitationMmPerHour!, frame.missing.precipitation!, i);
      const rainStatus = precipitationRateStatus(rain, minimumRateMmPerHour);
      precipitation.values[index] = rainStatus === STATUS_UNAVAILABLE ? NaN : rain;
      precipitation.flags[index] = rainStatus;
    }

    if (!daylight) {
      if (requiresLift) {
        const finiteTerrain = Number.isFinite(terrain);
        if (liftMsl) {
          liftMsl.values[index] = finiteTerrain ? terrain : NaN;
          liftMsl.flags[index] = finiteTerrain ? STATUS_NO_LIFT : STATUS_UNAVAILABLE;
        }
        if (liftAgl) {
          liftAgl.values[index] = finiteTerrain ? 0 : NaN;
          liftAgl.flags[index] = finiteTerrain ? STATUS_NO_LIFT : STATUS_UNAVAILABLE;
        }
        if (diagnostics) diagnostics.branch[index] = FRAME_BRANCH.skippedDark;
      }
      continue;
    }

    if (requiresLift) {
      const levelCount = readNativeColumn(frame, i, column);
      const lift = deriveColumn(
        column,
        levelCount,
        options
      );
      if (diagnostics) {
        writeColumnDiagnostics(diagnostics, index, terrain, lift.branch, lift.depthM, lift.thermalVelocityMps);
      }
      if (liftMsl) {
        liftMsl.values[index] = lift.msl.value ?? NaN;
        liftMsl.flags[index] = lift.msl.flags | cloudSupport;
      }
      if (liftAgl) {
        liftAgl.values[index] = lift.agl.value ?? NaN;
        liftAgl.flags[index] = lift.agl.flags | cloudSupport;
      }
    }

  }
  return result;
}
