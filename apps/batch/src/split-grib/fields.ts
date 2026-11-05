import type { SplitSource } from './source.js';
import { sourceCycle, sourceUrl, sourceWindowStart } from '../source.js';
import type { DecodedSplitGribField } from './grib.js';

export function validateSplitGribCycle(source: SplitSource, cycleIso: string): string {
  return sourceCycle(cycleIso, source.model.forecast.cycleHoursUtc);
}

export function formatSplitGribRunStamp(source: SplitSource, cycleIso: string): {
  readonly runStamp: string;
  readonly cycleHour: string;
} {
  const normalized = validateSplitGribCycle(source, cycleIso);
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
 * Construct the official DWD Open Data `.grib2.bz2` URL for a regular-lat-lon Split GRIB field.
 */
export function splitGribRegularFieldUrl(source: SplitSource,
  field: string,
  cycleIso: string,
  options: {
    readonly hour?: number;
    readonly level?: number | null;
    readonly baseUrl?: string;
  } = {}
): string {
  const spec = (Object.hasOwn(source.specs, field) ? source.specs[field] : undefined);
  if (!spec) {
    throw new Error(`Unsupported Split GRIB field ${field}`);
  }
  const level = options.level;
  const levelRequired = spec.kind === 'model-level' || field === source.upstream.fields.halfLevelHeight.field;
  if (levelRequired && (!Number.isInteger(level) || level! < 1 || level! > (spec.kind === 'model-level' ? source.modelLevels[0]! : source.halfLevels.at(-1)!))) throw new Error('Invalid source vertical level');
  const hour = options.hour ?? 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 120) throw new Error(`Source forecast hour out of range: ${hour}`);
  const suffix = spec.kind === 'time-invariant' ? (levelRequired ? `_${level}` : '')
    : `_${String(hour).padStart(3, '0')}${levelRequired ? `_${level}` : ''}`;
  const template = options.baseUrl ? source.upstream.urlTemplate.replace(/^.*?(?=\/\{cycleHour\})/, options.baseUrl.replace(/\/+$/, '')) : source.upstream.urlTemplate;
  return sourceUrl(template, { ...formatSplitGribRunStamp(source, cycleIso), field, fieldLower: field.toLowerCase(), kind: spec.kind, suffix });
}

/**
 * Verify that a decoded Split GRIB GRIB2 field matches the expected run cycle, grid geometry,
 * parameter identity, vertical level, and forecast time window.
 */
export function verifySplitGribFieldMetadata(source: SplitSource,
  decoded: DecodedSplitGribField,
  field: string,
  cycleIso: string,
  options: { readonly hour?: number; readonly level?: number | null } = {}
): void {
  const spec = (Object.hasOwn(source.specs, field) ? source.specs[field] : undefined);
  if (!spec) {
    throw new Error(`Unsupported Split GRIB field ${field}`);
  }
  const cycleMs = Date.parse(validateSplitGribCycle(source, cycleIso));
  const id = decoded.identification;
  const actualRefMs = Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second);
  if (actualRefMs !== cycleMs) {
    throw new Error(
      `Split GRIB ${field} reference time mismatch: expected ${new Date(cycleMs).toISOString()}, got ${new Date(actualRefMs).toISOString()}`
    );
  }
  if (decoded.identification.centre !== source.upstream.centre) {
    throw new Error(`Split GRIB ${field} unexpected originating centre ${decoded.identification.centre} (expected ${source.upstream.centre})`);
  }
  const lonFirstNorm = ((decoded.grid.longitudeOfFirstGridPoint + 180) % 360 + 360) % 360 - 180;
  const lonLastNorm = ((decoded.grid.longitudeOfLastGridPoint + 180) % 360 + 360) % 360 - 180;
  const latSouth = Math.min(decoded.grid.latitudeOfFirstGridPoint, decoded.grid.latitudeOfLastGridPoint);
  const latNorth = Math.max(decoded.grid.latitudeOfFirstGridPoint, decoded.grid.latitudeOfLastGridPoint);
  if (
    Math.abs(lonFirstNorm - source.grid.lon0) > 1e-4 ||
    Math.abs(latNorth - source.grid.lat0) > 1e-4 ||
    Math.abs(latSouth - (source.grid.lat0 + (source.grid.height - 1) * source.grid.dy)) > 1e-4 ||
    Math.abs(lonLastNorm - (source.grid.lon0 + (source.grid.width - 1) * source.grid.dx)) > 1e-4 ||
    Math.abs(decoded.grid.iDirectionIncrement - source.grid.dx) > 1e-6 ||
    Math.abs(Math.abs(decoded.grid.jDirectionIncrement) - Math.abs(source.grid.dy)) > 1e-6
  ) {
    throw new Error(`Split GRIB ${field} horizontal grid geometry mismatch`);
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
      `Split GRIB ${field} GRIB2 parameter/template mismatch: got d=${decoded.discipline} c=${p.parameterCategory} n=${p.parameterNumber} t=4.${p.templateNumber} s1=${p.firstFixedSurfaceType} s2=${p.secondFixedSurfaceType}`
    );
  }

  const expectedHour = spec.kind === 'time-invariant' ? 0 : (options.hour ?? 0);
  if (spec.templateNumber === 0) {
    if (Math.abs(p.endHour - expectedHour) > 1e-6) {
      throw new Error(
        `Split GRIB ${field} forecast hour mismatch: expected f${expectedHour}, got f${p.endHour}`
      );
    }
  } else {
    if (
      p.statisticalProcessCode !== spec.statisticalProcessCode ||
      Math.abs(p.startHour - sourceWindowStart(source.model.forecast, expectedHour)) > 1e-6 ||
      Math.abs(p.endHour - expectedHour) > 1e-6
    ) {
      throw new Error(
        `Split GRIB ${field} statistical interval mismatch: expected ${sourceWindowStart(source.model.forecast, expectedHour)}..${expectedHour}h (process ${spec.statisticalProcessCode}), got ${p.startHour}..${p.endHour}h (process ${p.statisticalProcessCode})`
      );
    }
  }

  if (spec.firstFixedSurfaceValue !== null && p.firstFixedSurfaceValue !== spec.firstFixedSurfaceValue) {
    throw new Error(
      `Split GRIB ${field} fixed surface value mismatch: expected ${spec.firstFixedSurfaceValue}, got ${String(p.firstFixedSurfaceValue)}`
    );
  }

  if (options.level !== undefined && options.level !== null) {
    if (p.firstFixedSurfaceValue !== options.level) {
      throw new Error(
        `Split GRIB ${field} model level mismatch: expected ${options.level}, got ${String(p.firstFixedSurfaceValue)}`
      );
    }
    if (spec.kind === 'model-level' && p.secondFixedSurfaceValue !== options.level + 1) {
      throw new Error(
        `Split GRIB ${field} lower half-level mismatch: expected ${options.level + 1}, got ${String(p.secondFixedSurfaceValue)}`
      );
    }
  }
}
