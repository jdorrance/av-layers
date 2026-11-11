import type { IndexedSource } from './source.js';
import { normalizeLon } from '@av/contracts';
import { parseFields, parseGrid, parseProduct, type GribField, type Grid, type ProductDefinition } from '@azohra/meteo.grib';
import { IndexedGribError } from './errors.ts';
import { indexedGribFirstFixedSurface } from './fields.ts';
import { readIndexedGribStatisticalInterval, receiptInterval, validAt, type IndexedGribInterval } from './intervals.ts';
import { sha256 } from './transport.ts';
import type { DecodedFieldReceipt, IndexedGribFieldSpec } from './types.ts';

const SUPPORTED_PACKING = new Set([0, 2, 3, 40]);
const LAMBERT_FIRST_CELL_TOLERANCE_M = 0.25;
const LAMBERT_ANGLE_TOLERANCE_DEG = 1e-10;

function refuse(code: 'source-conflict' | 'unsupported-grid' | 'unsupported-earth' | 'unsupported-packing', message: string): never {
  throw new IndexedGribError(code, message);
}

function sameRun(cycle: string, id: GribField['identification']): boolean {
  const actual = new Date(
    Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second),
  )
    .toISOString()
    .replace('.000Z', 'Z');
  return actual === cycle;
}

function validateGrid(source: IndexedSource, grid: Grid): void {
  const expected = source.grid;
  if (
    grid.ni !== expected.width || grid.nj !== expected.height ||
    grid.numberOfDataPoints !== expected.width * expected.height ||
    grid.jPointsAreConsecutive ||
    grid.alternativeRowScanning
  ) {
    refuse('unsupported-grid', 'Indexed GRIB grid geometry or scanning mode is unsupported');
  }
  if (grid.earthRadiusM !== expected.earthRadiusM) {
    refuse('unsupported-earth', `Unsupported Indexed GRIB earth radius ${grid.earthRadiusM}`);
  }
  if (expected.kind === 'regular-latlon') {
    if (grid.kind !== 'latlon' || grid.gridDefinitionTemplateNumber !== 0 ||
      grid.latitudeOfFirstGridPoint !== expected.lat0 || grid.longitudeOfFirstGridPoint !== source.upstream.nativeLongitudeOrigin ||
      grid.iDirectionIncrement !== expected.dx || grid.jDirectionIncrement !== -expected.dy ||
      grid.iScansNegatively || grid.jScansPositively || grid.uvRelativeToGrid) {
      refuse('unsupported-grid', 'Indexed GRIB grid geometry or scanning mode is unsupported');
    }
  } else {
    const southernCone = expected.standardParallel1Deg + expected.standardParallel2Deg < 0;
    const projectionCentreFlag = southernCone ? 0x80 : 0;
    if (grid.kind !== 'lambert' || grid.gridDefinitionTemplateNumber !== 30 ||
      grid.projectionCentreFlag !== projectionCentreFlag ||
      Math.abs(normalizeLon(grid.loV - expected.centralMeridianDeg)) > LAMBERT_ANGLE_TOLERANCE_DEG ||
      Math.abs(grid.laD - expected.latitudeOfOriginDeg) > LAMBERT_ANGLE_TOLERANCE_DEG ||
      Math.abs(grid.latin1 - expected.standardParallel1Deg) > LAMBERT_ANGLE_TOLERANCE_DEG ||
      Math.abs(grid.latin2 - expected.standardParallel2Deg) > LAMBERT_ANGLE_TOLERANCE_DEG ||
      grid.scanningMode !== ((expected.dxM < 0 ? 128 : 0) | (expected.dyM > 0 ? 64 : 0)) ||
      grid.dxM * (grid.iScansNegatively ? -1 : 1) !== expected.dxM ||
      grid.dyM * (grid.jScansPositively ? 1 : -1) !== expected.dyM ||
      (grid.southPoleLatitude !== -90 && grid.southPoleLatitude !== 0) || normalizeLon(grid.southPoleLongitude) !== 0) {
      refuse('unsupported-grid', 'Indexed GRIB Lambert geometry or scanning mode is unsupported');
    }
    const first = source.geometry.geographicToGrid(grid.latitudeOfFirstGridPoint, grid.longitudeOfFirstGridPoint);
    // GRIB2 encodes the first latitude and longitude in whole microdegrees.
    if (!first || Math.hypot(first.x * expected.dxM, first.y * expected.dyM) > LAMBERT_FIRST_CELL_TOLERANCE_M) {
      refuse('unsupported-grid', 'Indexed GRIB Lambert first cell differs from the configured grid');
    }
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
  if (field.section5.length < 21) refuse('unsupported-packing', 'Truncated Indexed GRIB section 5');
  const view = new DataView(field.section5.buffer, field.section5.byteOffset, field.section5.byteLength);
  const packing = view.getUint16(9);
  const codedCount = view.getUint32(5);
  if (!SUPPORTED_PACKING.has(packing)) {
    refuse('unsupported-packing', `Unsupported Indexed GRIB packing template 5.${packing}`);
  }
  const signedMagnitude = (offset: number) => {
    const value = view.getUint16(offset);
    return (value & 0x8000 ? -1 : 1) * (value & 0x7fff);
  };
  const binaryScale = signedMagnitude(15);
  const decimalScale = signedMagnitude(17);
  const minimumLength = packing === 3 ? 49 : packing === 2 ? 47 : packing === 40 ? 23 : 21;
  if (field.section5.length < minimumLength) refuse('unsupported-packing', `Truncated Indexed GRIB packing template 5.${packing}`);
  const bitsPerValue = view.getUint8(19);
  const numberOfGroups = packing === 2 || packing === 3 ? view.getUint32(31) : null;
  const referenceValue = view.getFloat32(11);
  const constant = numberOfGroups === 0 || (numberOfGroups === null && bitsPerValue === 0);
  // Zero is invariant under decimal scaling, including in decoders that ignore it for constants.
  if (decimalScale !== 0 && constant && referenceValue !== 0) {
    throw new IndexedGribError('unsupported-packing', `Indexed GRIB constant template 5.${packing} has unsupported decimal scaling`, {
      packing, decimalScaleFactor: decimalScale, binaryScaleFactor: binaryScale,
      bitsPerValue, numberOfGroups, referenceValue,
      encodingSha256: sha256(field.section5),
    });
  }
  const packingError = 0.5 * Math.pow(2, binaryScale) * Math.pow(10, -decimalScale);
  if (!Number.isFinite(packingError) || packingError < 0) {
    throw new IndexedGribError('unsupported-packing', 'Invalid Indexed GRIB packing error');
  }
  return { packing, packingError, codedCount };
}

export interface InspectIndexedGribFieldOptions {
  cycle: string;
  spec: IndexedGribFieldSpec;
  expectedStartHour: number;
  expectedEndHour: number;
  expectedGridKey?: string;
}

export interface InspectedIndexedGribField {
  field: GribField;
  grid: Grid;
  product: ProductDefinition;
  interval: IndexedGribInterval;
  packing: number;
  packingError: number;
  codedCount: number;
  bitmapIndicator: number;
  receipt: Omit<
    DecodedFieldReceipt,
    'product' | 'productFile' | 'url' | 'idxLine' | 'idxLineNumber' | 'asset'
  >;
}

export function inspectIndexedGribField(source: IndexedSource, bytes: Uint8Array, options: InspectIndexedGribFieldOptions): InspectedIndexedGribField {
  const { cycle, spec, expectedStartHour, expectedEndHour, expectedGridKey } = options;
  const fields = parseFields(bytes);
  if (fields.length !== 1) {
    throw new IndexedGribError('source-conflict', `Expected exactly one Indexed GRIB field for ${spec.key}, got ${fields.length}`);
  }
  const field = fields[0]!;
  const id = field.identification;
  if (field.discipline !== 0 || id.centre !== source.upstream.centre ||
    (source.upstream.subCentre !== undefined && id.subCentre !== source.upstream.subCentre) || !sameRun(cycle, id)) {
    throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB producer/discipline/run for ${spec.key}`);
  }
  const grid = parseGrid(field.section3);
  validateGrid(source, grid);
  if (expectedGridKey && grid.gridKey !== expectedGridKey) {
    throw new IndexedGribError('source-conflict', `Indexed GRIB grid key differs for ${spec.key}`);
  }
  const product = parseProduct(field.section4);
  const expectedParameter = source.upstream.parameters[spec.variable];
  if (
    !expectedParameter ||
    product.parameterCategory !== expectedParameter[0] ||
    product.parameterNumber !== expectedParameter[1]
  ) {
    throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB parameter identity for ${spec.key}`);
  }
  const [expectedSurface, expectedSurfaceValue] = spec.fixedSurface ?? indexedGribFirstFixedSurface(spec.level);
  const actualSurfaceValue = scalarLevel(product);
  if (
    product.typeOfFirstFixedSurface !== expectedSurface ||
    (actualSurfaceValue !== null && !Number.isFinite(actualSurfaceValue)) ||
    actualSurfaceValue !== expectedSurfaceValue ||
    product.typeOfSecondFixedSurface !== undefined
  ) {
    throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB fixed surface/level for ${spec.key}`, {
      expectedSurface,
      expectedSurfaceValue,
      actualSurface: product.typeOfFirstFixedSurface,
      actualSurfaceValue,
    });
  }
  const interval = readIndexedGribStatisticalInterval(field.section4, id);
  if (interval.kind === 'instant') {
    if (spec.statistic !== 'instant') {
      throw new IndexedGribError('source-conflict', `Expected statistical window for ${spec.key}`);
    }
    if (Date.parse(interval.start) !== Date.parse(validAt(cycle, expectedEndHour))) {
      throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB instant valid time for ${spec.key}`);
    }
  } else {
    if (spec.statistic === 'instant') {
      throw new IndexedGribError('source-conflict', `Expected instantaneous field for ${spec.key}`);
    }
    const expectedProcess = spec.statistic === 'accumulation' ? 1 : 0;
    if (interval.process !== expectedProcess) {
      throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB statistical process for ${spec.key}`);
    }
    if (interval.missingCount !== 0) {
      throw new IndexedGribError('source-conflict', `Indexed GRIB statistical interval reports missing samples for ${spec.key}`);
    }
    if (
      Date.parse(interval.start) !== Date.parse(validAt(cycle, expectedStartHour)) ||
      Date.parse(interval.end) !== Date.parse(validAt(cycle, expectedEndHour))
    ) {
      throw new IndexedGribError('source-conflict', `Wrong Indexed GRIB statistical window for ${spec.key}`, {
        interval,
        expectedStart: validAt(cycle, expectedStartHour),
        expectedEnd: validAt(cycle, expectedEndHour),
      });
    }
  }
  const { packing, packingError, codedCount } = packingMetadata(field);
  if (codedCount > grid.numberOfDataPoints || codedCount <= 0) {
    throw new IndexedGribError('source-conflict', `Invalid Indexed GRIB coded count for ${spec.key}`);
  }
  const bitmapIndicator = field.section6 ? field.section6[5]! : 255;
  const metadata = {
    key: spec.key,
    kind: spec.kind,
    role: spec.role ?? 'current',
    ...(spec.outputUnit ? { normalization: { units: spec.outputUnit, scale: spec.scale ?? 1, ...(spec.conversion ? { conversion: spec.conversion } : {}) } } : {}),
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
      uvRelativeToGrid: grid.uvRelativeToGrid,
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
    unit: source.upstream.parameters[spec.variable]![2] ?? 'unknown',
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
