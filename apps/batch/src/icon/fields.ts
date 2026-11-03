import { ICON_EU_PRODUCT } from '@av/contracts';
import {
  ICON_EU_BASE_URL,
  ICON_EU_CYCLE_HOURS_UTC,
  ICON_EU_GRID,
  ICON_EU_GRID_TOKEN,
  ICON_EU_HALF_LEVELS,
  ICON_EU_MODEL_LEVELS
} from './constants.js';
import type { DecodedIconGribField } from './grib.js';

const MAX_ICON_HALF_LEVEL = ICON_EU_HALF_LEVELS.at(-1)!;
const MAX_ICON_MODEL_LEVEL = ICON_EU_MODEL_LEVELS[0]!;

export type IconFieldKind = 'time-invariant' | 'single-level' | 'model-level';

export interface IconFieldSpec {
  readonly field: string;
  readonly kind: IconFieldKind;
  readonly discipline: number;
  readonly parameterCategory: number;
  readonly parameterNumber: number;
  readonly templateNumber: 0 | 8;
  readonly firstFixedSurfaceType: number;
  readonly firstFixedSurfaceValue: number | null;
  readonly secondFixedSurfaceType: number;
  readonly statisticalProcessCode: number | null;
}

export const ICON_FIELD_SPECS: Readonly<Record<string, IconFieldSpec>> = Object.freeze({
  HSURF: Object.freeze({
    field: 'HSURF',
    kind: 'time-invariant',
    discipline: 0,
    parameterCategory: 3,
    parameterNumber: 6,
    templateNumber: 0,
    firstFixedSurfaceType: 1,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 101,
    statisticalProcessCode: null
  }),
  HHL: Object.freeze({
    field: 'HHL',
    kind: 'time-invariant',
    discipline: 0,
    parameterCategory: 3,
    parameterNumber: 6,
    templateNumber: 0,
    firstFixedSurfaceType: 150,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 101,
    statisticalProcessCode: null
  }),
  PS: Object.freeze({
    field: 'PS',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 3,
    parameterNumber: 0,
    templateNumber: 0,
    firstFixedSurfaceType: 1,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: null
  }),
  T_2M: Object.freeze({
    field: 'T_2M',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 0,
    parameterNumber: 0,
    templateNumber: 0,
    firstFixedSurfaceType: 103,
    firstFixedSurfaceValue: 2,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: null
  }),
  QV_2M: Object.freeze({
    field: 'QV_2M',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 1,
    parameterNumber: 0,
    templateNumber: 0,
    firstFixedSurfaceType: 103,
    firstFixedSurfaceValue: 2,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: null
  }),
  MH: Object.freeze({
    field: 'MH',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 19,
    parameterNumber: 3,
    templateNumber: 0,
    firstFixedSurfaceType: 1,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: null
  }),
  ASHFL_S: Object.freeze({
    field: 'ASHFL_S',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 0,
    parameterNumber: 11,
    templateNumber: 8,
    firstFixedSurfaceType: 1,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: 0
  }),
  ALHFL_S: Object.freeze({
    field: 'ALHFL_S',
    kind: 'single-level',
    discipline: 0,
    parameterCategory: 0,
    parameterNumber: 10,
    templateNumber: 8,
    firstFixedSurfaceType: 1,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 255,
    statisticalProcessCode: 0
  }),
  T: Object.freeze({
    field: 'T',
    kind: 'model-level',
    discipline: 0,
    parameterCategory: 0,
    parameterNumber: 0,
    templateNumber: 0,
    firstFixedSurfaceType: 150,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 150,
    statisticalProcessCode: null
  }),
  P: Object.freeze({
    field: 'P',
    kind: 'model-level',
    discipline: 0,
    parameterCategory: 3,
    parameterNumber: 0,
    templateNumber: 0,
    firstFixedSurfaceType: 150,
    firstFixedSurfaceValue: null,
    secondFixedSurfaceType: 150,
    statisticalProcessCode: null
  })
});

export function validateIconCycle(cycleIso: string): string {
  const date = new Date(cycleIso);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0 ||
    !ICON_EU_CYCLE_HOURS_UTC.includes(date.getUTCHours())
  ) {
    throw new Error('ICON-EU cycle must be a valid 00, 06, 12, or 18 UTC timestamp');
  }
  return date.toISOString();
}

export function formatIconRunStamp(cycleIso: string): {
  readonly runStamp: string;
  readonly cycleHour: string;
} {
  const normalized = validateIconCycle(cycleIso);
  const yyyy = normalized.slice(0, 4);
  const mm = normalized.slice(5, 7);
  const dd = normalized.slice(8, 10);
  const hh = normalized.slice(11, 13);
  return {
    runStamp: `${yyyy}${mm}${dd}${hh}`,
    cycleHour: hh
  };
}

/**
 * Construct the official DWD Open Data `.grib2.bz2` URL for a regular-lat-lon ICON-EU field.
 */
export function iconRegularFieldUrl(
  field: string,
  cycleIso: string,
  options: {
    readonly hour?: number;
    readonly level?: number | null;
    readonly baseUrl?: string;
  } = {}
): string {
  const spec = ICON_FIELD_SPECS[field];
  if (!spec) {
    throw new Error(`Unsupported ICON-EU field ${field}`);
  }
  const { runStamp, cycleHour } = formatIconRunStamp(cycleIso);
  const baseUrl = (options.baseUrl ?? ICON_EU_BASE_URL).replace(/\/+$/, '');
  const folder = field.toLowerCase();

  if (spec.kind === 'time-invariant') {
    if (field === 'HHL') {
      const level = options.level;
      if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > MAX_ICON_HALF_LEVEL) {
        throw new Error(`ICON-EU HHL requires an integer half-level in 1..${MAX_ICON_HALF_LEVEL}, got ${String(level)}`);
      }
      return `${baseUrl}/${cycleHour}/${folder}/icon-eu_${ICON_EU_GRID_TOKEN}_time-invariant_${runStamp}_${level}_${field}.grib2.bz2`;
    }
    return `${baseUrl}/${cycleHour}/${folder}/icon-eu_${ICON_EU_GRID_TOKEN}_time-invariant_${runStamp}_${field}.grib2.bz2`;
  }

  const hour = options.hour ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 120) {
    throw new Error(`ICON-EU forecast hour out of range: ${hour}`);
  }
  const fff = String(hour).padStart(3, '0');

  if (spec.kind === 'single-level') {
    return `${baseUrl}/${cycleHour}/${folder}/icon-eu_${ICON_EU_GRID_TOKEN}_single-level_${runStamp}_${fff}_${field}.grib2.bz2`;
  }

  const level = options.level;
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > MAX_ICON_MODEL_LEVEL) {
    throw new Error(`ICON-EU ${field} requires an integer model level in 1..${MAX_ICON_MODEL_LEVEL}, got ${String(level)}`);
  }
  return `${baseUrl}/${cycleHour}/${folder}/icon-eu_${ICON_EU_GRID_TOKEN}_model-level_${runStamp}_${fff}_${level}_${field}.grib2.bz2`;
}

/**
 * Verify that a decoded ICON-EU GRIB2 field matches the expected run cycle, grid geometry,
 * parameter identity, vertical level, and forecast time window.
 */
export function verifyIconFieldMetadata(
  decoded: DecodedIconGribField,
  field: string,
  cycleIso: string,
  options: { readonly hour?: number; readonly level?: number | null } = {}
): void {
  const spec = ICON_FIELD_SPECS[field];
  if (!spec) {
    throw new Error(`Unsupported ICON-EU field ${field}`);
  }
  const cycleMs = Date.parse(validateIconCycle(cycleIso));
  const id = decoded.identification;
  const actualRefMs = Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second);
  if (actualRefMs !== cycleMs) {
    throw new Error(
      `ICON-EU ${field} reference time mismatch: expected ${new Date(cycleMs).toISOString()}, got ${new Date(actualRefMs).toISOString()}`
    );
  }
  if (decoded.identification.centre !== 78) {
    throw new Error(`ICON-EU ${field} unexpected originating centre ${decoded.identification.centre} (expected 78 / DWD)`);
  }
  const lonFirstNorm = ((decoded.grid.longitudeOfFirstGridPoint + 180) % 360 + 360) % 360 - 180;
  const lonLastNorm = ((decoded.grid.longitudeOfLastGridPoint + 180) % 360 + 360) % 360 - 180;
  const latSouth = Math.min(decoded.grid.latitudeOfFirstGridPoint, decoded.grid.latitudeOfLastGridPoint);
  const latNorth = Math.max(decoded.grid.latitudeOfFirstGridPoint, decoded.grid.latitudeOfLastGridPoint);
  if (
    Math.abs(lonFirstNorm - ICON_EU_GRID.lon0) > 1e-4 ||
    Math.abs(latNorth - ICON_EU_GRID.lat0) > 1e-4 ||
    Math.abs(latSouth - ICON_EU_PRODUCT.bounds[1]) > 1e-4 ||
    Math.abs(lonLastNorm - ICON_EU_PRODUCT.bounds[2]) > 1e-4 ||
    Math.abs(decoded.grid.iDirectionIncrement - ICON_EU_GRID.dx) > 1e-6 ||
    Math.abs(Math.abs(decoded.grid.jDirectionIncrement) - Math.abs(ICON_EU_GRID.dy)) > 1e-6
  ) {
    throw new Error(`ICON-EU ${field} horizontal grid geometry mismatch`);
  }

  const p = decoded.product;
  if (
    decoded.discipline !== spec.discipline ||
    p.parameterCategory !== spec.parameterCategory ||
    p.parameterNumber !== spec.parameterNumber ||
    p.templateNumber !== spec.templateNumber ||
    p.firstFixedSurfaceType !== spec.firstFixedSurfaceType ||
    p.secondFixedSurfaceType !== spec.secondFixedSurfaceType
  ) {
    throw new Error(
      `ICON-EU ${field} GRIB2 parameter/template mismatch: got d=${decoded.discipline} c=${p.parameterCategory} n=${p.parameterNumber} t=4.${p.templateNumber} s1=${p.firstFixedSurfaceType} s2=${p.secondFixedSurfaceType}`
    );
  }

  const expectedHour = spec.kind === 'time-invariant' ? 0 : (options.hour ?? 0);
  if (spec.templateNumber === 0) {
    if (Math.abs(p.endHour - expectedHour) > 1e-6) {
      throw new Error(
        `ICON-EU ${field} forecast hour mismatch: expected f${expectedHour}, got f${p.endHour}`
      );
    }
  } else {
    // Template 4.8 run-averaged flux from 0..expectedHour
    if (
      p.statisticalProcessCode !== spec.statisticalProcessCode ||
      Math.abs(p.startHour - 0) > 1e-6 ||
      Math.abs(p.endHour - expectedHour) > 1e-6
    ) {
      throw new Error(
        `ICON-EU ${field} statistical interval mismatch: expected 0..${expectedHour}h (process ${spec.statisticalProcessCode}), got ${p.startHour}..${p.endHour}h (process ${p.statisticalProcessCode})`
      );
    }
  }

  if (spec.firstFixedSurfaceValue !== null && p.firstFixedSurfaceValue !== spec.firstFixedSurfaceValue) {
    throw new Error(
      `ICON-EU ${field} fixed surface value mismatch: expected ${spec.firstFixedSurfaceValue}, got ${String(p.firstFixedSurfaceValue)}`
    );
  }

  if (options.level !== undefined && options.level !== null) {
    if (p.firstFixedSurfaceValue !== options.level) {
      throw new Error(
        `ICON-EU ${field} model level mismatch: expected ${options.level}, got ${String(p.firstFixedSurfaceValue)}`
      );
    }
    if (spec.kind === 'model-level' && p.secondFixedSurfaceValue !== options.level + 1) {
      throw new Error(
        `ICON-EU ${field} lower half-level mismatch: expected ${options.level + 1}, got ${String(p.secondFixedSurfaceValue)}`
      );
    }
  }
}
