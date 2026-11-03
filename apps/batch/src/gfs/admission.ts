import { parseFields, parseGrid, parseProduct, type GribField, type Grid, type ProductDefinition } from '@azohra/meteo.grib';
import { GFS_NATIVE_GRID } from './constants.ts';
import { NoaaError } from './errors.ts';
import { GFS_PARAMETERS, gfsFirstFixedSurface } from './fields.ts';
import { readNoaaStatisticalInterval, receiptInterval, validAt, type NoaaInterval } from './intervals.ts';
import { sha256 } from './transport.ts';
import type { DecodedFieldReceipt, GfsFieldSpec } from './types.ts';

const SUPPORTED_PACKING = new Set([0, 2, 3, 40]);
const UNITS: Readonly<Record<string, string>> = Object.freeze({
  HGT: 'm',
  PRES: 'Pa',
  TMP: 'K',
  SPFH: 'kg/kg',
  HPBL: 'm',
  SHTFL: 'W/m2',
  LHTFL: 'W/m2',
  APCP: 'kg/m2',
});

function refuse(code: 'source-conflict' | 'unsupported-grid' | 'unsupported-earth' | 'unsupported-packing', message: string): never {
  throw new NoaaError(code, message);
}

function sameRun(cycle: string, id: GribField['identification']): boolean {
  const actual = new Date(
    Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second),
  )
    .toISOString()
    .replace('.000Z', 'Z');
  return actual === cycle;
}

function validateGrid(grid: Grid): void {
  if (grid.kind !== 'latlon') refuse('unsupported-grid', `Unsupported GFS grid template: ${grid.kind}`);
  if (grid.gridDefinitionTemplateNumber !== 0) {
    refuse('unsupported-grid', `Unsupported GFS grid definition template 3.${grid.gridDefinitionTemplateNumber}`);
  }
  if (
    grid.ni !== GFS_NATIVE_GRID.ni ||
    grid.nj !== GFS_NATIVE_GRID.nj ||
    grid.numberOfDataPoints !== GFS_NATIVE_GRID.ni * GFS_NATIVE_GRID.nj ||
    grid.latitudeOfFirstGridPoint !== GFS_NATIVE_GRID.lat0 ||
    grid.longitudeOfFirstGridPoint !== GFS_NATIVE_GRID.lon0 ||
    grid.iDirectionIncrement !== GFS_NATIVE_GRID.dlon ||
    grid.jDirectionIncrement !== -GFS_NATIVE_GRID.dlat ||
    grid.iScansNegatively ||
    grid.jScansPositively ||
    grid.jPointsAreConsecutive ||
    grid.alternativeRowScanning ||
    grid.uvRelativeToGrid
  ) {
    refuse('unsupported-grid', 'GFS grid geometry or scanning mode is unsupported');
  }
  if (grid.earthRadiusM !== GFS_NATIVE_GRID.earthRadiusM) {
    refuse('unsupported-earth', `Unsupported GFS earth radius ${grid.earthRadiusM}`);
  }
}

function scalarLevel(product: ProductDefinition): number | null {
  if (
    product.typeOfFirstFixedSurface === undefined ||
    product.scaledValueOfFirstFixedSurface === undefined ||
    product.scaleFactorOfFirstFixedSurface === undefined
  ) {
    return null;
  }
  return product.scaledValueOfFirstFixedSurface * 10 ** -product.scaleFactorOfFirstFixedSurface;
}

function packingMetadata(field: GribField): { packing: number; packingError: number; codedCount: number } {
  if (field.section5.length < 21) refuse('unsupported-packing', 'Truncated GFS section 5');
  const view = new DataView(field.section5.buffer, field.section5.byteOffset, field.section5.byteLength);
  const packing = view.getUint16(9);
  const codedCount = view.getUint32(5);
  if (!SUPPORTED_PACKING.has(packing)) {
    refuse('unsupported-packing', `Unsupported GFS packing template 5.${packing}`);
  }
  const signedMagnitude = (offset: number) => {
    const value = view.getUint16(offset);
    return (value & 0x8000 ? -1 : 1) * (value & 0x7fff);
  };
  const binaryScale = signedMagnitude(15);
  const decimalScale = signedMagnitude(17);
  const minimumLength = packing === 3 ? 49 : packing === 2 ? 47 : packing === 40 ? 23 : 21;
  if (field.section5.length < minimumLength) refuse('unsupported-packing', `Truncated GFS packing template 5.${packing}`);
  const bitsPerValue = view.getUint8(19);
  const numberOfGroups = packing === 2 || packing === 3 ? view.getUint32(31) : null;
  if (decimalScale !== 0 && (numberOfGroups === 0 || (numberOfGroups === null && bitsPerValue === 0))) {
    throw new NoaaError('unsupported-packing', `GFS constant template 5.${packing} has unsupported decimal scaling`, {
      packing, decimalScaleFactor: decimalScale, binaryScaleFactor: binaryScale,
      bitsPerValue, numberOfGroups, referenceValue: view.getFloat32(11),
      encodingSha256: sha256(field.section5),
    });
  }
  const packingError = 0.5 * Math.pow(2, binaryScale) * Math.pow(10, -decimalScale);
  if (!Number.isFinite(packingError) || packingError < 0) {
    throw new NoaaError('unsupported-packing', 'Invalid GFS packing error');
  }
  return { packing, packingError, codedCount };
}

export interface InspectGfsFieldOptions {
  cycle: string;
  spec: GfsFieldSpec;
  expectedStartHour: number;
  expectedEndHour: number;
  expectedGridKey?: string;
}

export interface InspectedGfsField {
  field: GribField;
  grid: Grid;
  product: ProductDefinition;
  interval: NoaaInterval;
  packing: number;
  packingError: number;
  codedCount: number;
  bitmapIndicator: number;
  receipt: Omit<
    DecodedFieldReceipt,
    'product' | 'productFile' | 'url' | 'idxLine' | 'idxLineNumber' | 'asset'
  >;
}

export function inspectGfsField(bytes: Uint8Array, options: InspectGfsFieldOptions): InspectedGfsField {
  const { cycle, spec, expectedStartHour, expectedEndHour, expectedGridKey } = options;
  const fields = parseFields(bytes);
  if (fields.length !== 1) {
    throw new NoaaError('source-conflict', `Expected exactly one GFS field for ${spec.key}, got ${fields.length}`);
  }
  const field = fields[0]!;
  const id = field.identification;
  if (field.discipline !== 0 || id.centre !== 7 || !sameRun(cycle, id)) {
    throw new NoaaError('source-conflict', `Wrong GFS producer/discipline/run for ${spec.key}`);
  }
  const grid = parseGrid(field.section3);
  validateGrid(grid);
  if (expectedGridKey && grid.gridKey !== expectedGridKey) {
    throw new NoaaError('source-conflict', `GFS grid key differs for ${spec.key}`);
  }
  const product = parseProduct(field.section4);
  const expectedParameter = GFS_PARAMETERS[spec.variable];
  if (
    !expectedParameter ||
    product.parameterCategory !== expectedParameter[0] ||
    product.parameterNumber !== expectedParameter[1]
  ) {
    throw new NoaaError('source-conflict', `Wrong GFS parameter identity for ${spec.key}`);
  }
  const [expectedSurface, expectedSurfaceValue] = gfsFirstFixedSurface(spec.level);
  const actualSurfaceValue = scalarLevel(product);
  if (
    product.typeOfFirstFixedSurface !== expectedSurface ||
    actualSurfaceValue === null ||
    !Number.isFinite(actualSurfaceValue) ||
    actualSurfaceValue !== expectedSurfaceValue ||
    product.typeOfSecondFixedSurface !== undefined
  ) {
    throw new NoaaError('source-conflict', `Wrong GFS fixed surface/level for ${spec.key}`, {
      expectedSurface,
      expectedSurfaceValue,
      actualSurface: product.typeOfFirstFixedSurface,
      actualSurfaceValue,
    });
  }
  const interval = readNoaaStatisticalInterval(field.section4, id);
  if (interval.kind === 'instant') {
    if (spec.statistic !== 'instant') {
      throw new NoaaError('source-conflict', `Expected statistical window for ${spec.key}`);
    }
    if (Date.parse(interval.start) !== Date.parse(validAt(cycle, expectedEndHour))) {
      throw new NoaaError('source-conflict', `Wrong GFS instant valid time for ${spec.key}`);
    }
  } else {
    if (spec.statistic === 'instant') {
      throw new NoaaError('source-conflict', `Expected instantaneous field for ${spec.key}`);
    }
    const expectedProcess = spec.statistic === 'accumulation' ? 1 : 0;
    if (interval.process !== expectedProcess) {
      throw new NoaaError('source-conflict', `Wrong GFS statistical process for ${spec.key}`);
    }
    if (interval.missingCount !== 0) {
      throw new NoaaError('source-conflict', `GFS statistical interval reports missing samples for ${spec.key}`);
    }
    if (
      Date.parse(interval.start) !== Date.parse(validAt(cycle, expectedStartHour)) ||
      Date.parse(interval.end) !== Date.parse(validAt(cycle, expectedEndHour))
    ) {
      throw new NoaaError('source-conflict', `Wrong GFS statistical window for ${spec.key}`, {
        interval,
        expectedStart: validAt(cycle, expectedStartHour),
        expectedEnd: validAt(cycle, expectedEndHour),
      });
    }
  }
  const { packing, packingError, codedCount } = packingMetadata(field);
  if (codedCount > grid.numberOfDataPoints || codedCount <= 0) {
    throw new NoaaError('source-conflict', `Invalid GFS coded count for ${spec.key}`);
  }
  const bitmapIndicator = field.section6 ? field.section6[5]! : 255;
  const metadata = {
    key: spec.key,
    kind: spec.kind,
    role: spec.role ?? 'current',
    variable: spec.variable,
    level: spec.level,
    levelHpa: spec.levelHpa ?? null,
    forecastLabel: spec.forecast,
    metadataSha256: sha256([field.section1, ...(field.section2 ? [field.section2] : []), field.section3, field.section4]),
    encodingSha256: sha256([field.section5, ...(field.section6 ? [field.section6] : [])]),
    identification: {
      centre: id.centre,
      subCentre: id.subCentre,
      significanceOfReferenceTime: id.significanceOfReferenceTime,
      year: id.year,
      month: id.month,
      day: id.day,
      hour: id.hour,
      minute: id.minute,
      second: id.second,
      productionStatus: id.productionStatus,
      typeOfProcessedData: id.typeOfProcessedData,
    },
    grid: {
      kind: grid.kind,
      gridKey: grid.gridKey,
      ni: grid.ni,
      nj: grid.nj,
      numberOfDataPoints: grid.numberOfDataPoints,
      gridDefinitionTemplateNumber: grid.gridDefinitionTemplateNumber,
      scanningMode: grid.scanningMode,
      earthRadiusM: grid.earthRadiusM,
    },
    productMetadata: {
      productDefinitionTemplateNumber: product.productDefinitionTemplateNumber,
      parameterCategory: product.parameterCategory,
      parameterNumber: product.parameterNumber,
      typeOfGeneratingProcess: product.typeOfGeneratingProcess,
      indicatorOfUnitOfTimeRange: product.indicatorOfUnitOfTimeRange,
      forecastTime: product.forecastTime,
      typeOfFirstFixedSurface: product.typeOfFirstFixedSurface,
      scaleFactorOfFirstFixedSurface: product.scaleFactorOfFirstFixedSurface,
      scaledValueOfFirstFixedSurface: product.scaledValueOfFirstFixedSurface,
      typeOfSecondFixedSurface: product.typeOfSecondFixedSurface,
      numberOfCoordinateValues: product.numberOfCoordinateValues,
    },
    interval: receiptInterval(interval),
    packing,
    packingError,
    bitmapIndicator,
    codedCount,
    decodedMissingCount: 0,
    unit: UNITS[spec.variable] ?? 'unknown',
  };
  return {
    field,
    grid,
    product,
    interval,
    packing,
    packingError,
    codedCount,
    bitmapIndicator,
    receipt: metadata,
  };
}
