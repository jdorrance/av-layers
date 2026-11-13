import {
  decodeFieldValues,
  parseFields,
  parseGrid,
  parseProduct,
  type Identification
} from '@azohra/meteo.grib';
import { MAX_SPLIT_OBJECT_BYTES, type SplitSource } from './source.js';
import { decompressBzip2, isBzip2Compressed } from './codec/bzip2.js';
import { decodeCcsdsSamples } from './codec/ccsds.js';

export interface DecodedSplitGribField {
  readonly discipline: number;
  readonly identification: Identification;
  readonly grid: (Extract<ReturnType<typeof parseGrid>, { kind: 'latlon' }> & {
    readonly scanningMode: number;
    readonly earthShapeCode: number;
  }) | {
    readonly kind: 'unstructured';
    readonly numberOfDataPoints: number;
    readonly earthShapeCode: number;
    readonly numberOfGridUsed: number;
    readonly numberOfGridInReference: number;
    readonly uuidOfHGrid: string;
  };
  readonly product: {
    readonly templateNumber: number;
    readonly parameterCategory: number;
    readonly parameterNumber: number;
    readonly firstFixedSurfaceType: number;
    readonly firstFixedSurfaceValue: number | null;
    readonly secondFixedSurfaceType: number;
    readonly secondFixedSurfaceValue: number | null;
    readonly coordinateValueCount: number;
    readonly validTimeIso: string;
    readonly startHour: number;
    readonly endHour: number;
    readonly statisticalProcessCode: number | null;
  };
  readonly representation: {
    readonly dataRepresentationTemplateNumber: number;
    readonly codedValueCount: number;
    readonly bitsPerValue: number;
    readonly referenceValue: number;
    readonly binaryScaleFactor: number;
    readonly decimalScaleFactor: number;
    readonly packingError: number;
  };
  readonly expandedBytes: number;
  /** Unnormalized statistical windows retain Float64 values through interval recovery. */
  readonly values: Float32Array | Float64Array;
  readonly missing: Uint8Array;
}

const TIME_UNIT_HOURS: Readonly<Record<number, number>> = {
  0: 1 / 60, // minutes
  1: 1, // hours
  2: 24, // days
  10: 3, // 3 hours
  11: 6, // 6 hours
  12: 12, // 12 hours
  13: 1 / 3600 // seconds
};

function readSigned16(view: DataView, byteOffset: number): number {
  const raw = view.getUint16(byteOffset, false);
  return (raw & 0x8000) !== 0 ? -(raw & 0x7fff) : raw;
}

function parseSection4Metadata(
  section4: Uint8Array,
  referenceTimeIso: string
): DecodedSplitGribField['product'] {
  if (section4.byteLength < 34) {
    throw new Error(`Truncated GRIB2 Section 4 (${section4.byteLength} bytes)`);
  }
  const view = new DataView(section4.buffer, section4.byteOffset, section4.byteLength);
  const parsed = parseProduct(section4);
  const coordinateValueCount = parsed.numberOfCoordinateValues;
  const templateNumber = parsed.productDefinitionTemplateNumber;
  if (templateNumber !== 0 && templateNumber !== 8) {
    throw new Error(`Unsupported Split GRIB GRIB2 product definition template 4.${templateNumber}`);
  }
  if (parsed.typeOfGeneratingProcess !== 2) {
    throw new Error('Unsupported Split GRIB generating process');
  }
  const { parameterCategory, parameterNumber } = parsed;
  const timeUnitCode = parsed.indicatorOfUnitOfTimeRange!;
  const unitHours = TIME_UNIT_HOURS[timeUnitCode];
  if (unitHours === undefined) {
    throw new Error(`Unsupported GRIB2 time range unit code ${timeUnitCode}`);
  }
  const startOrValidHours = parsed.forecastTime! * unitHours;
  if (!Number.isFinite(startOrValidHours) || startOrValidHours < 0) {
    throw new Error('Invalid Split GRIB forecast time');
  }

  const surfaceValue = (scale: number | undefined, value: number | undefined) =>
    scale === undefined || value === undefined ? null : value * 10 ** -scale;
  const firstFixedSurfaceType = parsed.typeOfFirstFixedSurface ?? 255;
  const firstFixedSurfaceValue = surfaceValue(parsed.scaleFactorOfFirstFixedSurface, parsed.scaledValueOfFirstFixedSurface);
  const secondFixedSurfaceType = parsed.typeOfSecondFixedSurface ?? 255;
  const secondFixedSurfaceValue = surfaceValue(parsed.scaleFactorOfSecondFixedSurface, parsed.scaledValueOfSecondFixedSurface);

  const refMs = Date.parse(referenceTimeIso);
  if (templateNumber === 0) {
    if (section4.byteLength !== 34 + 4 * coordinateValueCount) throw new Error('Unsupported Split GRIB instantaneous product layout');
    const validTimeIso = new Date(refMs + startOrValidHours * 3_600_000).toISOString();
    return {
      templateNumber,
      parameterCategory,
      parameterNumber,
      firstFixedSurfaceType,
      firstFixedSurfaceValue,
      secondFixedSurfaceType,
      secondFixedSurfaceValue,
      coordinateValueCount,
      validTimeIso,
      startHour: startOrValidHours,
      endHour: startOrValidHours,
      statisticalProcessCode: null
    };
  }

  // Template 4.8: Average, accumulation, extreme values
  if (section4.byteLength !== 58 + 4 * coordinateValueCount || view.getUint8(41) !== 1) {
    throw new Error('Split GRIB statistical product requires exactly one time range');
  }
  if (view.getUint32(42, false) !== 0) throw new Error('Split GRIB statistical interval contains missing samples');
  const endYear = view.getUint16(34, false);
  const endMonth = view.getUint8(36);
  const endDay = view.getUint8(37);
  const endHourUtc = view.getUint8(38);
  const endMinute = view.getUint8(39);
  const endSecond = view.getUint8(40);
  const endMs = Date.UTC(endYear, endMonth - 1, endDay, endHourUtc, endMinute, endSecond);
  const end = new Date(endMs);
  if (end.getUTCFullYear() !== endYear || end.getUTCMonth() + 1 !== endMonth ||
      end.getUTCDate() !== endDay || end.getUTCHours() !== endHourUtc ||
      end.getUTCMinutes() !== endMinute || end.getUTCSeconds() !== endSecond) {
    throw new Error('Invalid Split GRIB statistical interval date');
  }
  const validTimeIso = end.toISOString();
  if (view.getUint8(47) !== 2 || view.getUint32(54, false) !== 0 ||
      (view.getUint8(53) !== 255 && TIME_UNIT_HOURS[view.getUint8(53)] === undefined)) {
    throw new Error('Unsupported Split GRIB statistical increment');
  }
  const statisticalProcessCode = view.getUint8(46);
  const statUnitCode = view.getUint8(48);
  const statUnitHours = TIME_UNIT_HOURS[statUnitCode];
  if (statUnitHours === undefined) {
    throw new Error(`Unsupported GRIB2 statistical time unit code ${statUnitCode}`);
  }
  const rangeLengthRaw = view.getUint32(49, false);
  const durationHours = rangeLengthRaw * statUnitHours;
  const endHour = (endMs - refMs) / 3_600_000;
  const startHour = endHour - durationHours;
  if (durationHours <= 0 || Math.abs(startHour - startOrValidHours) > 1e-6) {
    throw new Error('Split GRIB statistical endpoints and range length differ');
  }

  return {
    templateNumber,
    parameterCategory,
    parameterNumber,
    firstFixedSurfaceType,
    firstFixedSurfaceValue,
    secondFixedSurfaceType,
    secondFixedSurfaceValue,
    coordinateValueCount,
    validTimeIso,
    startHour,
    endHour,
    statisticalProcessCode
  };
}

function sourceGrid(source: SplitSource, section3: Uint8Array): DecodedSplitGribField['grid'] {
  if (section3.byteLength < 14) throw new Error('Truncated GRIB2 Section 3');
  const s3View = new DataView(section3.buffer, section3.byteOffset, section3.byteLength);
  const gridTemplateNumber = s3View.getUint16(12, false);
  const native = source.upstream.nativeGrid;
  if (native) {
    if (gridTemplateNumber !== 101) throw new Error(`Expected GRIB2 grid template 3.101 (unstructured), got 3.${gridTemplateNumber}`);
    if (section3.byteLength !== 35 || section3[5] !== 0 || section3[10] !== 0 || section3[11] !== 0) {
      throw new Error('Unsupported Split GRIB unstructured grid layout');
    }
    const grid = {
      kind: 'unstructured' as const,
      numberOfDataPoints: s3View.getUint32(6, false),
      earthShapeCode: s3View.getUint8(14),
      numberOfGridUsed: s3View.getUint16(15, false) * 256 + s3View.getUint8(17),
      numberOfGridInReference: s3View.getUint8(18),
      uuidOfHGrid: Buffer.from(section3.subarray(19, 35)).toString('hex')
    };
    if (grid.numberOfDataPoints !== native.pointCount || grid.numberOfGridUsed !== native.number ||
        grid.numberOfGridInReference !== 1 || grid.uuidOfHGrid !== native.uuid || grid.earthShapeCode !== 6) {
      throw new Error('Split GRIB native grid identity mismatch');
    }
    return grid;
  }
  if (section3.byteLength < 72) throw new Error('Truncated GRIB2 regular grid');
  const grid = parseGrid(section3);
  if (grid.kind !== 'latlon' || gridTemplateNumber !== 0) {
    throw new Error(`Expected GRIB2 grid template 3.0 (regular lat/lon), got 3.${gridTemplateNumber}`);
  }
  const earthShapeCode = s3View.getUint8(14);
  const scanningMode = s3View.getUint8(71);

  const width = grid.ni;
  const height = grid.nj;
  const pointCount = width * height;
  if (
    width !== source.grid.width ||
    height !== source.grid.height ||
    grid.numberOfDataPoints !== pointCount
  ) {
    throw new Error(
      `Split GRIB grid dimension mismatch: expected ${source.grid.width}x${source.grid.height}, got ${width}x${height} (${grid.numberOfDataPoints})`
    );
  }
  if (scanningMode !== 64 && scanningMode !== 0) {
    throw new Error(`Unsupported Split GRIB scanning mode ${scanningMode}`);
  }
  const southToNorth = scanningMode === 64;
  if (southToNorth ? grid.latitudeOfFirstGridPoint >= grid.latitudeOfLastGridPoint
    : grid.latitudeOfFirstGridPoint <= grid.latitudeOfLastGridPoint) {
    throw new Error('Split GRIB scanning mode disagrees with latitude endpoints');
  }
  return { ...grid, scanningMode, earthShapeCode };
}

/** Decode selected native mesh cells or regular north-to-south grid indices into caller-owned targets. */
export function decodeSplitGribField(source: SplitSource,
  inputBytes: Uint8Array,
  activeIndices: Uint32Array,
  target?: { values: Float32Array; missing: Uint8Array }
): DecodedSplitGribField {
  const gribBytes = isBzip2Compressed(inputBytes) ? decompressBzip2(inputBytes, MAX_SPLIT_OBJECT_BYTES) : inputBytes;
  if (gribBytes.byteLength > MAX_SPLIT_OBJECT_BYTES) throw new Error('Split GRIB expanded object byte length out of bounds');
  const fields = parseFields(gribBytes);
  if (fields.length !== 1) {
    throw new Error(`Expected exactly 1 GRIB2 field in Split GRIB object, found ${fields.length}`);
  }
  const field = fields[0]!;
  const grid = sourceGrid(source, field.section3), pointCount = grid.numberOfDataPoints;
  for (const index of activeIndices) {
    if (index >= pointCount) throw new RangeError(`Active cell index ${index} exceeds Split GRIB grid size ${pointCount}`);
  }
  if (target && (target.values.length !== activeIndices.length || target.missing.length !== activeIndices.length)) {
    throw new RangeError('Split GRIB target length mismatch');
  }

  const id = field.identification;
  const referenceTimeIso = new Date(
    Date.UTC(id.year, id.month - 1, id.day, id.hour, id.minute, id.second)
  ).toISOString();

  const product = parseSection4Metadata(field.section4, referenceTimeIso);

  const s5 = field.section5;
  if (s5.byteLength < 21) {
    throw new Error(`Truncated GRIB2 Section 5 (${s5.byteLength} bytes)`);
  }
  const s5View = new DataView(s5.buffer, s5.byteOffset, s5.byteLength);
  const codedValueCount = s5View.getUint32(5, false);
  if (codedValueCount > pointCount) throw new Error('GRIB2 coded value count exceeds grid point count');
  const drt = s5View.getUint16(9, false);
  const referenceValue = s5View.getFloat32(11, false);
  const binaryScaleFactor = readSigned16(s5View, 15);
  const decimalScaleFactor = readSigned16(s5View, 17);
  const bitsPerValue = s5View.getUint8(19);
  const binaryScale = 2 ** binaryScaleFactor;
  const decimalScale = 10 ** -decimalScaleFactor;
  const packingError = bitsPerValue === 0 ? 0 : 0.5 * binaryScale * decimalScale;

  const s6 = field.section6 as Uint8Array | null | undefined;
  let hasBitmap = false;
  let bitmapBytes: Uint8Array | null = null;
  if (s6 instanceof Uint8Array && s6.byteLength > 0) {
    if (s6.byteLength >= 6 && s6[4] === 6) {
      const bitmapIndicator = s6[5]!;
      if (bitmapIndicator !== 255 && bitmapIndicator !== 0) {
        throw new Error(`Unsupported GRIB2 Section 6 bitmap indicator ${bitmapIndicator}`);
      }
      hasBitmap = bitmapIndicator === 0;
      bitmapBytes = hasBitmap ? s6.subarray(6) : null;
    } else {
      hasBitmap = true;
      bitmapBytes = s6;
    }
  }
  if (hasBitmap && bitmapBytes!.byteLength < Math.ceil(pointCount / 8)) {
    throw new Error('Truncated GRIB2 Section 6 bitmap');
  }
  let presentCount = pointCount;
  if (hasBitmap) {
    presentCount = 0;
    for (let i = 0; i < pointCount; i += 1) presentCount += (bitmapBytes![i >> 3]! >> (7 - (i & 7))) & 1;
  }
  if (codedValueCount !== presentCount) throw new Error('GRIB2 coded value count differs from grid/bitmap coverage');

  if (drt === 42 && s5.byteLength < 25) throw new Error(`Truncated GRIB2 Section 5.42 (${s5.byteLength} bytes)`);
  const retainPrecise = !target && product.templateNumber === 8;
  const allocValues = (length: number): Float64Array | Float32Array => retainPrecise ? new Float64Array(length) : new Float32Array(length);
  let fullValues: Float64Array | Float32Array;
  if ((drt === 0 || drt === 42) && bitsPerValue === 0) {
    // ecCodes treats zero-bit 5.0/5.42 fields as the unscaled reference value.
    fullValues = allocValues(pointCount).fill(referenceValue);
    if (hasBitmap) for (let i = 0; i < pointCount; i++) {
      if (!(bitmapBytes![i >> 3]! & (0x80 >> (i & 7)))) fullValues[i] = NaN;
    }
  } else if (drt === 42) {
    const flags = s5View.getUint8(21);
    const blockSize = s5View.getUint8(22);
    const rsi = s5View.getUint16(23, false);
    const payload = field.section7.subarray(5);

    const decodedCoded = allocValues(codedValueCount);
    if (codedValueCount > 0) {
      const rawSamples = decodeCcsdsSamples(payload, {
        bitsPerSample: bitsPerValue,
        blockSize,
        rsi,
        flags,
        sampleCount: codedValueCount
      });
      for (let i = 0; i < codedValueCount; i += 1) {
        decodedCoded[i] = (referenceValue + rawSamples[i]! * binaryScale) * decimalScale;
      }
    }

    if (!hasBitmap) {
      fullValues = decodedCoded;
    } else {
      const expanded = allocValues(pointCount);
      let codedIdx = 0;
      for (let i = 0; i < pointCount; i += 1) {
        const present = (bitmapBytes![i >> 3]! & (0x80 >> (i & 7))) !== 0;
        if (present) {
          expanded[i] = decodedCoded[codedIdx]!;
          codedIdx += 1;
        } else {
          expanded[i] = NaN;
        }
      }
      fullValues = expanded;
    }
  } else if (drt === 0 && !hasBitmap && bitsPerValue === 8) {
    const payload = field.section7.subarray(5);
    if (payload.byteLength < codedValueCount) throw new Error('Truncated GRIB2 simple-packing payload');
    const decoded = allocValues(pointCount);
    for (let i = 0; i < pointCount; i += 1) {
      decoded[i] = (referenceValue + payload[i]! * binaryScale) * decimalScale;
    }
    fullValues = decoded;
  } else {
    fullValues = decodeFieldValues(field, { missingValue: NaN }).values;
  }

  const outValues = target?.values ?? allocValues(activeIndices.length);
  const outMissing = target?.missing ?? new Uint8Array(activeIndices.length);

  for (let i = 0; i < activeIndices.length; i += 1) {
    let sourceIdx = activeIndices[i]!;
    if (grid.kind === 'latlon' && grid.scanningMode === 64) {
      const row = Math.floor(sourceIdx / grid.ni);
      sourceIdx += (grid.nj - 1 - 2 * row) * grid.ni;
    }
    const value = fullValues[sourceIdx]!;
    if (Number.isFinite(value)) {
      outValues[i] = value;
      outMissing[i] = 0;
    } else {
      outValues[i] = NaN;
      outMissing[i] = 1;
    }
  }

  return {
    discipline: field.discipline,
    identification: field.identification,
    grid,
    product,
    representation: {
      dataRepresentationTemplateNumber: drt,
      codedValueCount,
      bitsPerValue,
      referenceValue,
      binaryScaleFactor,
      decimalScaleFactor,
      packingError
    },
    expandedBytes: gribBytes.byteLength,
    values: outValues,
    missing: outMissing
  };
}
