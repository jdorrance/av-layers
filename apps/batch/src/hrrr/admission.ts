import { parseFields, parseGrid, parseProduct, type GribField, type Grid, type Identification, type ProductDefinition } from '@azohra/meteo.grib';
import { HRRR_PARAMETERS, hrrrFirstFixedSurface } from './fields.ts';
import { HRRR_PRODUCT_NAMES } from './constants.ts';
import { NoaaError } from '../noaa/errors.ts';
import { receiptInterval, readNoaaStatisticalInterval, validAt, type NoaaInterval } from '../noaa/intervals.ts';
import { sha256 } from '../noaa/transport.ts';
import { assertHrrrGrid } from './grid.ts';
import type { HrrrFieldReceipt, HrrrFieldSpec } from './types.ts';

const SUPPORTED_PACKING = new Set([0, 2, 3, 40]);

function refuse(code: 'source-conflict' | 'unsupported-packing', message: string, details?: Record<string, unknown>): never {
  throw new NoaaError(code, message, details);
}

function sameRun(cycle: string, id: Identification): boolean {
  return new Date(Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second)).toISOString().replace('.000Z', 'Z') === cycle;
}

function scalarLevel(product: ProductDefinition): number | null {
  if (
    product.typeOfFirstFixedSurface === undefined ||
    product.scaledValueOfFirstFixedSurface === undefined ||
    product.scaleFactorOfFirstFixedSurface === undefined
  ) return null;
  return product.scaledValueOfFirstFixedSurface * 10 ** -product.scaleFactorOfFirstFixedSurface;
}

export function admitHrrrProduct(product: ProductDefinition, spec: HrrrFieldSpec): void {
  const identity = HRRR_PARAMETERS[spec.variable];
  if (!identity || product.parameterCategory !== identity[0] || product.parameterNumber !== identity[1]) {
    refuse('source-conflict', `Wrong HRRR parameter identity for ${spec.key}`, {
      expected: identity,
      actual: [product.parameterCategory, product.parameterNumber],
    });
  }
  if (product.numberOfCoordinateValues !== 0 || product.typeOfSecondFixedSurface !== undefined) {
    refuse('source-conflict', `HRRR coordinate/layer metadata refused for ${spec.key}`);
  }
  const [surface, value] = hrrrFirstFixedSurface(spec.level);
  const actualValue = scalarLevel(product);
  if (
    product.typeOfFirstFixedSurface !== surface ||
    actualValue === null ||
    !Number.isFinite(actualValue) ||
    actualValue !== value
  ) {
    refuse('source-conflict', `Wrong HRRR fixed surface/level for ${spec.key}`, {
      expectedSurface: surface,
      expectedValue: value,
      actualSurface: product.typeOfFirstFixedSurface,
      actualValue,
    });
  }
}

const sameInstant = (a: string, b: string) => Date.parse(a) === Date.parse(b);

export function admitHrrrInterval(interval: NoaaInterval, spec: HrrrFieldSpec, cycle: string, hour: number): void {
  if (spec.statistic === 'instant') {
    if (interval.kind !== 'instant') refuse('source-conflict', `HRRR ${spec.key} must remain instantaneous, not a relabelled window`);
    if (!sameInstant(interval.start, validAt(cycle, hour)) || !sameInstant(interval.end, interval.start)) {
      refuse('source-conflict', `Wrong HRRR instant valid time for ${spec.key}`, { interval });
    }
    return;
  }
  if (interval.kind !== 'window') refuse('source-conflict', `HRRR ${spec.key} requires a statistical interval`);
  const range = interval.ranges[0];
  if (
    interval.process !== 1 ||
    interval.missingCount !== 0 ||
    range.rangeLength !== 1 ||
    !sameInstant(interval.start, validAt(cycle, hour - 1)) ||
    !sameInstant(interval.end, validAt(cycle, hour))
  ) {
    refuse('source-conflict', `HRRR ${spec.key} must prove the exact one-hour trailing accumulation`, {
      interval,
      expectedStart: validAt(cycle, hour - 1),
      expectedEnd: validAt(cycle, hour),
    });
  }
}

export function packingMetadata(field: GribField): { packing: number; packingError: number; codedCount: number } {
  if (field.section5.length < 21) refuse('unsupported-packing', 'Truncated HRRR section 5');
  const view = new DataView(field.section5.buffer, field.section5.byteOffset, field.section5.byteLength);
  const packing = view.getUint16(9), codedCount = view.getUint32(5);
  if (!SUPPORTED_PACKING.has(packing)) refuse('unsupported-packing', `Unsupported HRRR packing template 5.${packing}`);
  const signedMagnitude = (offset: number) => {
    const raw = view.getUint16(offset);
    return (raw & 0x8000 ? -1 : 1) * (raw & 0x7fff);
  };
  const packingError = 0.5 * Math.pow(2, signedMagnitude(15)) * Math.pow(10, -signedMagnitude(17));
  if (!Number.isFinite(packingError) || packingError < 0) refuse('unsupported-packing', 'Invalid HRRR packing error');
  return { packing, packingError, codedCount };
}

export interface InspectHrrrFieldOptions {
  cycle: string;
  hour: number;
  spec: HrrrFieldSpec;
  expectedGridKey?: string;
}

export interface InspectedHrrrField {
  field: GribField;
  grid: Grid;
  product: ProductDefinition;
  interval: NoaaInterval;
  packing: number;
  packingError: number;
  codedCount: number;
  bitmapIndicator: number;
  receipt: Omit<HrrrFieldReceipt, 'asset' | 'idxLine' | 'idxLineNumber' | 'productFile' | 'decodedMissingCount'>;
}

export function inspectHrrrField(bytes: Uint8Array, options: InspectHrrrFieldOptions): InspectedHrrrField {
  const { cycle, hour, spec, expectedGridKey } = options;
  const fields = parseFields(bytes);
  if (fields.length !== 1) refuse('source-conflict', `Expected exactly one HRRR field for ${spec.key}, got ${fields.length}`);
  const field = fields[0]!;
  const id = field.identification;
  if (field.discipline !== 0 || id.centre !== 7 || id.subCentre !== 0 || id.significanceOfReferenceTime !== 1 || !sameRun(cycle, id)) {
    refuse('source-conflict', `Wrong HRRR producer/discipline/run for ${spec.key}`);
  }
  const grid = parseGrid(field.section3);
  if (grid.kind !== 'lambert') throw new NoaaError('unsupported-grid', `HRRR field ${spec.key} is not Lambert`);
  assertHrrrGrid(grid, expectedGridKey);
  const product = parseProduct(field.section4);
  admitHrrrProduct(product, spec);
  const interval = readNoaaStatisticalInterval(field.section4, id);
  admitHrrrInterval(interval, spec, cycle, hour);
  const { packing, packingError, codedCount } = packingMetadata(field);
  if (codedCount <= 0 || codedCount > grid.numberOfDataPoints) {
    refuse('source-conflict', `Invalid HRRR coded count for ${spec.key}`);
  }
  const bitmapIndicator = field.section6 ? field.section6[5]! : 255;
  return {
    field,
    grid,
    product,
    interval,
    packing,
    packingError,
    codedCount,
    bitmapIndicator,
    receipt: {
      key: spec.key,
      kind: spec.kind,
      product: spec.product,
      variable: spec.variable,
      level: spec.level,
      levelHpa: spec.levelHpa ?? null,
      forecastLabel: spec.forecast,
      statistic: spec.statistic,
      unit: spec.unit,
      conversion: spec.conversion,
      identification: id,
      productMetadata: product,
      grid: {
        kind: 'lambert',
        gridKey: grid.gridKey,
        ni: grid.ni,
        nj: grid.nj,
        numberOfDataPoints: grid.numberOfDataPoints,
        gridDefinitionTemplateNumber: grid.gridDefinitionTemplateNumber,
        scanningMode: grid.scanningMode,
        earthRadiusM: grid.earthRadiusM,
      },
      interval: receiptInterval(interval),
      packing,
      packingError,
      codedCount,
      bitmapIndicator,
      metadataSha256: sha256(Buffer.concat([field.section1, ...(field.section2 ? [field.section2] : []), field.section3, field.section4])),
      encodingSha256: sha256(Buffer.concat([field.section5, ...(field.section6 ? [field.section6] : [])])),
    },
  };
}

export function hrrrProductFile(spec: HrrrFieldSpec): string {
  return HRRR_PRODUCT_NAMES[spec.product];
}
