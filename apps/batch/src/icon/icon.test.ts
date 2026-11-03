import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  coverageIndices,
  ICON_EU_GRID,
  ICON_EU_PRODUCT,
  setBit,
  STATUS_MASK,
  STATUS_VALID,
  type CoverageMask
} from '@av/contracts';
import {
  deriveFrame,
  prepareSamplePackLayout,
  resolveProductFrameHours,
  validateNormalizedFrame
} from '@av/forecast';
import { loadCoverage } from '../coverage.js';
import { prepareBuild } from '../capacity.js';
import { iconEuProvider } from './provider.js';
import { createIconEuAcquisitionSession, deaverageIconHourlyUpwardFlux } from './acquire.js';
import { decodeIconGribField } from './grib.js';
import { ICON_EU_HALF_LEVELS, ICON_EU_MODEL_LEVELS } from './constants.js';
import { iconRegularFieldUrl, verifyIconFieldMetadata } from './fields.js';
import { iconRunSentinelUrls } from './discover.js';
import { isBzip2Compressed } from './codec/bzip2.js';

const PROBE_DIR = process.env['ICON_DWD_PROBE_DIR'];

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

/**
 * Build a minimal valid single-field GRIB2 message encoded with DRT 5.0 (simple packing)
 * on the 1377x657 ICON-EU regular-lat-lon grid for fast unit tests.
 */
function buildSyntheticIconGrib2(options: {
  discipline?: number;
  centre?: number;
  referenceTimeIso: string;
  scanningMode?: number;
  coordinateValueCount?: number;
  templateNumber: 0 | 8;
  parameterCategory: number;
  parameterNumber: number;
  firstFixedSurfaceType: number;
  firstFixedSurfaceValue: number | null;
  secondFixedSurfaceType?: number;
  secondFixedSurfaceValue?: number | null;
  hour: number;
  constantValue: number;
  overridePoint?: { sourceRow: number; col: number; value: number };
}): Uint8Array {
  const width = ICON_EU_GRID.width;
  const height = ICON_EU_GRID.height;
  const pointCount = width * height;
  const ref = new Date(options.referenceTimeIso);

  // Section 1 (21 bytes)
  const s1 = new Uint8Array(21);
  const v1 = new DataView(s1.buffer);
  v1.setUint32(0, 21, false);
  v1.setUint8(4, 1);
  v1.setUint16(5, options.centre ?? 78, false);
  v1.setUint16(7, 255, false);
  v1.setUint8(9, 19);
  v1.setUint8(10, 1);
  v1.setUint8(11, 1);
  v1.setUint16(12, ref.getUTCFullYear(), false);
  v1.setUint8(14, ref.getUTCMonth() + 1);
  v1.setUint8(15, ref.getUTCDate());
  v1.setUint8(16, ref.getUTCHours());
  v1.setUint8(17, ref.getUTCMinutes());
  v1.setUint8(18, ref.getUTCSeconds());
  v1.setUint8(19, 0);
  v1.setUint8(20, 1);

  // Section 3 (72 bytes, Template 3.0)
  const s3 = new Uint8Array(72);
  const v3 = new DataView(s3.buffer);
  v3.setUint32(0, 72, false);
  v3.setUint8(4, 3);
  v3.setUint8(5, 0);
  v3.setUint32(6, pointCount, false);
  v3.setUint8(10, 0);
  v3.setUint8(11, 0);
  v3.setUint16(12, 0, false);
  v3.setUint8(14, 6); // Earth spherical radius 6,371,229 m
  v3.setUint32(30, width, false);
  v3.setUint32(34, height, false);
  v3.setUint32(38, 0, false);
  v3.setUint32(42, 0xffffffff, false);
  const scan = options.scanningMode ?? 64;
  const latFirst = scan === 64 ? 29_500_000 : 70_500_000;
  const latLast = scan === 64 ? 70_500_000 : 29_500_000;
  v3.setUint32(46, latFirst, false);
  v3.setUint32(50, 336_500_000, false); // -23.5° in 0..360 microdegrees
  v3.setUint8(54, 48);
  v3.setUint32(55, latLast, false);
  v3.setUint32(59, 62_500_000, false);
  v3.setUint32(63, 62_500, false);
  v3.setUint32(67, 62_500, false);
  v3.setUint8(71, scan);

  // Section 4 (Template 4.0 = 34 bytes, Template 4.8 = 58 bytes)
  const s4Len = (options.templateNumber === 0 ? 34 : 58) + 4 * (options.coordinateValueCount ?? 0);
  const s4 = new Uint8Array(s4Len);
  const v4 = new DataView(s4.buffer);
  v4.setUint32(0, s4Len, false);
  v4.setUint8(4, 4);
  v4.setUint16(5, options.coordinateValueCount ?? 0, false);
  v4.setUint16(7, options.templateNumber, false);
  v4.setUint8(9, options.parameterCategory);
  v4.setUint8(10, options.parameterNumber);
  v4.setUint8(11, 2);
  v4.setUint8(17, 0); // minutes
  v4.setUint32(18, options.templateNumber === 0 ? options.hour * 60 : 0, false);
  v4.setUint8(22, options.firstFixedSurfaceType);
  if (options.firstFixedSurfaceValue === null) {
    v4.setUint8(23, 0xff);
    v4.setUint32(24, 0xffffffff, false);
  } else {
    v4.setUint8(23, 0);
    v4.setUint32(24, options.firstFixedSurfaceValue, false);
  }
  const s2Type = options.secondFixedSurfaceType ?? 255;
  v4.setUint8(28, s2Type);
  if (options.secondFixedSurfaceValue === undefined || options.secondFixedSurfaceValue === null) {
    v4.setUint8(29, 0xff);
    v4.setUint32(30, 0xffffffff, false);
  } else {
    v4.setUint8(29, 0);
    v4.setUint32(30, options.secondFixedSurfaceValue, false);
  }
  if (options.templateNumber === 8) {
    const end = new Date(ref.getTime() + options.hour * 3_600_000);
    v4.setUint16(34, end.getUTCFullYear(), false);
    v4.setUint8(36, end.getUTCMonth() + 1);
    v4.setUint8(37, end.getUTCDate());
    v4.setUint8(38, end.getUTCHours());
    v4.setUint8(39, end.getUTCMinutes());
    v4.setUint8(40, end.getUTCSeconds());
    v4.setUint8(41, 1);
    v4.setUint32(42, 0, false);
    v4.setUint8(46, 0); // average
    v4.setUint8(47, 2);
    v4.setUint8(48, 0); // minutes
    v4.setUint32(49, options.hour * 60, false);
  }

  // Section 5 (DRT 5.42 CCSDS: if constantValue and no overridePoint, bitsPerValue = 0;
  // otherwise DRT 5.0 simple packing with 8 bits per value)
  const hasOverride = options.overridePoint !== undefined;
  const s5Len = hasOverride ? 21 : 25;
  const s5 = new Uint8Array(s5Len);
  const v5 = new DataView(s5.buffer);
  v5.setUint32(0, s5Len, false);
  v5.setUint8(4, 5);
  v5.setUint32(5, pointCount, false);
  v5.setUint16(9, hasOverride ? 0 : 42, false);
  v5.setFloat32(11, options.constantValue, false);
  v5.setUint16(15, 0, false);
  v5.setUint16(17, 0, false);
  v5.setUint8(19, hasOverride ? 8 : 0);
  v5.setUint8(20, 0);
  if (!hasOverride) {
    v5.setUint8(21, 14);
    v5.setUint8(22, 32);
    v5.setUint16(23, 128, false);
  }

  // Section 6 (6 bytes, bitmapIndicator = 255)
  const s6 = Uint8Array.of(0, 0, 0, 6, 6, 255);

  // Section 7
  const payloadLen = hasOverride ? pointCount : 0;
  const s7 = new Uint8Array(5 + payloadLen);
  const v7 = new DataView(s7.buffer);
  v7.setUint32(0, s7.byteLength, false);
  v7.setUint8(4, 7);
  if (hasOverride) {
    const idx = options.overridePoint!.sourceRow * width + options.overridePoint!.col;
    s7[5 + idx] = Math.round(options.overridePoint!.value - options.constantValue);
  }

  const totalLen = 16 + s1.byteLength + s3.byteLength + s4.byteLength + s5.byteLength + s6.byteLength + s7.byteLength + 4;
  const out = new Uint8Array(totalLen);
  const vOut = new DataView(out.buffer);
  out.set([0x47, 0x52, 0x49, 0x42], 0); // "GRIB"
  vOut.setUint8(6, options.discipline ?? 0);
  vOut.setUint8(7, 2);
  vOut.setBigUint64(8, BigInt(totalLen), false);
  let offset = 16;
  for (const sec of [s1, s3, s4, s5, s6, s7]) {
    out.set(sec, offset);
    offset += sec.byteLength;
  }
  out.set([0x37, 0x37, 0x37, 0x37], offset); // "7777"
  return out;
}

function syntheticFetch(cycle: string, requestedUrls: string[]): typeof fetch {
  return async input => {
    const url = String(input);
    requestedUrls.push(url);
    const file = url.split('/').at(-1)!;
    const body = (bytes: Uint8Array): ArrayBuffer =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    if (file.endsWith('_HSURF.grib2.bz2')) {
      return new Response(
        body(buildSyntheticIconGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: 3,
          parameterNumber: 6,
          firstFixedSurfaceType: 1,
          firstFixedSurfaceValue: null,
          secondFixedSurfaceType: 101,
          hour: 0,
          constantValue: 1000
        }))
      );
    }
    const hhlMatch = file.match(/_(\d+)_HHL\.grib2\.bz2$/);
    if (hhlMatch) {
      const level = Number(hhlMatch[1]);
      const height = 1000 + (75 - level) * 200;
      return new Response(
        body(buildSyntheticIconGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: 3,
          parameterNumber: 6,
          firstFixedSurfaceType: 150,
          firstFixedSurfaceValue: level,
          secondFixedSurfaceType: 101,
          hour: 0,
          constantValue: height
        }))
      );
    }
    const modelMatch = file.match(/_(\d{3})_(\d+)_(T|P)\.grib2\.bz2$/);
    if (modelMatch) {
      const hour = Number(modelMatch[1]);
      const level = Number(modelMatch[2]);
      const field = modelMatch[3];
      const value =
        field === 'T'
          ? 290 - (74 - level) * 1.5 + hour * 0.1
          : 89000 - (74 - level) * 1500;
      return new Response(
        body(buildSyntheticIconGrib2({
          referenceTimeIso: cycle,
          templateNumber: 0,
          parameterCategory: field === 'T' ? 0 : 3,
          parameterNumber: 0,
          firstFixedSurfaceType: 150,
          firstFixedSurfaceValue: level,
          secondFixedSurfaceType: 150,
          secondFixedSurfaceValue: level + 1,
          hour,
          constantValue: value
        }))
      );
    }
    const singleMatch = file.match(/_(\d{3})_(PS|T_2M|QV_2M|MH|ASHFL_S|ALHFL_S)\.grib2\.bz2$/);
    if (singleMatch) {
      const hour = Number(singleMatch[1]);
      const field = singleMatch[2]!;
      const specMap: Record<
        string,
        { t: 0 | 8; cat: number; num: number; s1: number; v1: number | null; val: number }
      > = {
        PS: { t: 0, cat: 3, num: 0, s1: 1, v1: null, val: 90000 },
        T_2M: { t: 0, cat: 0, num: 0, s1: 103, v1: 2, val: 295 + hour * 0.2 },
        QV_2M: { t: 0, cat: 1, num: 0, s1: 103, v1: 2, val: 0.008 },
        MH: { t: 0, cat: 19, num: 3, s1: 1, v1: null, val: 1200 },
        ASHFL_S: { t: 8, cat: 0, num: 11, s1: 1, v1: null, val: -150 - hour * 10 },
        ALHFL_S: { t: 8, cat: 0, num: 10, s1: 1, v1: null, val: -60 - hour * 5 }
      };
      const cfg = specMap[field]!;
      return new Response(
        body(buildSyntheticIconGrib2({
          referenceTimeIso: cycle,
          templateNumber: cfg.t,
          parameterCategory: cfg.cat,
          parameterNumber: cfg.num,
          firstFixedSurfaceType: cfg.s1,
          firstFixedSurfaceValue: cfg.v1,
          hour,
          constantValue: cfg.val
        }))
      );
    }
    return new Response('not found', { status: 404 });
  };
}

describe('DWD ICON-EU regular-lat-lon adapter & compatibility proof', () => {
  it('constructs canonical DWD Open Data URLs and sentinel probes', () => {
    const cycle = '2026-10-08T00:00:00Z';
    expect(iconRegularFieldUrl('HSURF', cycle)).toBe(
      'https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/hsurf/icon-eu_europe_regular-lat-lon_time-invariant_2026100800_HSURF.grib2.bz2'
    );
    expect(iconRegularFieldUrl('HHL', cycle, { level: 75 })).toBe(
      'https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/hhl/icon-eu_europe_regular-lat-lon_time-invariant_2026100800_75_HHL.grib2.bz2'
    );
    expect(iconRegularFieldUrl('ASHFL_S', cycle, { hour: 6 })).toBe(
      'https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/ashfl_s/icon-eu_europe_regular-lat-lon_single-level_2026100800_006_ASHFL_S.grib2.bz2'
    );
    expect(iconRegularFieldUrl('T', cycle, { hour: 6, level: 74 })).toBe(
      'https://opendata.dwd.de/weather/nwp/icon-eu/grib/00/t/icon-eu_europe_regular-lat-lon_model-level_2026100800_006_74_T.grib2.bz2'
    );
    const sentinels = iconRunSentinelUrls(cycle);
    expect(sentinels).toHaveLength(7);
    expect(sentinels.some(u => u.endsWith('_024_MH.grib2.bz2'))).toBe(true);
  });

  it('flips DWD south-to-north (+j, scanningMode 64) rows into normalized north-to-south (-j) grid order', () => {
    const cycle = '2026-10-08T00:00:00Z';
    // Yerevan: j = 171 from south (29.5 + 171 * 0.0625 = 40.1875N), i = 1088 (-23.5 + 1088 * 0.0625 = 44.5E)
    // In normalized north-to-south order (row 0 = 70.5N): row = 656 - 171 = 485
    const normRow = ICON_EU_GRID.height - 1 - 171;
    const normIndex = normRow * ICON_EU_GRID.width + 1088;
    const grib = buildSyntheticIconGrib2({
      referenceTimeIso: cycle,
      scanningMode: 64,
      templateNumber: 0,
      parameterCategory: 3,
      parameterNumber: 6,
      firstFixedSurfaceType: 1,
      firstFixedSurfaceValue: null,
      secondFixedSurfaceType: 101,
      hour: 0,
      constantValue: 500,
      overridePoint: { sourceRow: 171, col: 1088, value: 542 }
    });
    const decoded = decodeIconGribField(grib, Uint32Array.of(normIndex, 0));
    verifyIconFieldMetadata(decoded, 'HSURF', cycle);
    expect(decoded.values[0]).toBe(542);
    expect(decoded.values[1]).toBe(500);
    expect(decoded.missing).toEqual(Uint8Array.of(0, 0));
  });

  it.each([
    ['multiple ranges', 41, 2],
    ['missing samples', 45, 1],
    ['different increment type', 47, 1],
    ['nonzero increment', 57, 1],
    ['unsupported increment unit', 53, 254],
    ['inconsistent start time', 21, 1],
    ['invalid end date', 36, 13],
    ['truncated coordinate values', 6, 1],
    ['wrong generating process', 11, 1]
  ] as const)('refuses statistical metadata with %s', (_label, byteOffset, value) => {
    const bytes = buildSyntheticIconGrib2({ referenceTimeIso: '2026-10-08T00:00:00Z',
      templateNumber: 8, parameterCategory: 0, parameterNumber: 11,
      firstFixedSurfaceType: 1, firstFixedSurfaceValue: null, hour: 6, constantValue: -100 });
    bytes[16 + 21 + 72 + byteOffset] = value;
    expect(() => decodeIconGribField(bytes, Uint32Array.of(0))).toThrow();
  });

  it('accepts the six coordinate values carried by DWD model-level fields', () => {
    const cycle = '2026-10-08T00:00:00Z';
    const bytes = buildSyntheticIconGrib2({ referenceTimeIso: cycle, coordinateValueCount: 6,
      templateNumber: 0, parameterCategory: 0, parameterNumber: 0,
      firstFixedSurfaceType: 150, firstFixedSurfaceValue: 74,
      secondFixedSurfaceType: 150, secondFixedSurfaceValue: 75, hour: 6, constantValue: 290 });
    const decoded = decodeIconGribField(bytes, Uint32Array.of(0));
    verifyIconFieldMetadata(decoded, 'T', cycle, { hour: 6, level: 74 });
    expect(decoded.product.coordinateValueCount).toBe(6);
    expect(decoded.values[0]).toBe(290);
  });

  it('de-averages first-hour (0..1h) and multi-hour (0..h vs 0..h-1) downward fluxes into upward W/m²', () => {
    const f1 = {
      values: new Float32Array([-80, 25, NaN]),
      missing: Uint8Array.of(0, 0, 1),
      product: {} as never
    };
    const r1 = deaverageIconHourlyUpwardFlux(f1, null, 1);
    expect(Array.from(r1.values.slice(0, 2))).toEqual([80, -25]);
    expect(Number.isNaN(r1.values[2]!)).toBe(true);
    expect(r1.missing).toEqual(Uint8Array.of(0, 0, 1));

    // At h=2, run-average 0..2h is -110 W/m² -> 2*(-110) - 1*(-80) = -140 downward = +140 upward W/m²
    const f2 = {
      values: new Float32Array([-110, 10, 0]),
      missing: Uint8Array.of(0, 0, 0),
      product: {} as never
    };
    const r2 = deaverageIconHourlyUpwardFlux(f2, f1, 2);
    expect(r2.values[0]).toBeCloseTo(140, 5);
    expect(r2.values[1]).toBeCloseTo(5, 5);
    expect(Number.isNaN(r2.values[2]!)).toBe(true);
    expect(r2.missing).toEqual(Uint8Array.of(0, 0, 1));
  });

  it('caches static HSURF/HHL across forecast hours, fetches T/P per hour, and fetches preceding-hour flux companions', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-session-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z';
    const requestedUrls: string[] = [];

    const fetchStub = syntheticFetch(cycle, requestedUrls);

    const active = Uint32Array.of(0, 1);
    const session = await createIconEuAcquisitionSession({
      cycle,
      activeIndices: active,
      cacheDir,
      fetchImpl: fetchStub
    });

    // Acquire hour 4 first (simulating first daylight hour of the run -> must fetch f003 flux companions)
    const frame4 = await session.acquire(4);
    validateNormalizedFrame(
      frame4,
      active,
      ICON_EU_GRID,
      ICON_EU_MODEL_LEVELS.length,
      ICON_EU_PRODUCT.layers
    );
    expect(frame4.precipitationMmPerHour).toBeUndefined();
    expect(frame4.pressureLevelsHpa).toBeUndefined();
    expect(frame4.pressurePa).toHaveLength(30);
    expect(frame4.hgtM[0]![0]).toBe(1100); // midpoint of HHL[74]=1200 and HHL[75]=1000
    expect(frame4.intervals.usedCompanion).toBe(true);
    // f004 ASHFL_S = -190, f003 ASHFL_S = -180 -> -(4*-190 - 3*-180) = -(-760 + 540) = +220 W/m²
    expect(frame4.sensibleHeatFluxWm2[0]).toBeCloseTo(220, 5);

    const hsurfDownloadsAfterF4 = requestedUrls.filter(u => u.includes('_HSURF.grib2.bz2')).length;
    const hhlDownloadsAfterF4 = requestedUrls.filter(u => u.includes('_HHL.grib2.bz2')).length;
    expect(hsurfDownloadsAfterF4).toBe(1);
    expect(hhlDownloadsAfterF4).toBe(ICON_EU_HALF_LEVELS.length);
    expect(requestedUrls.some(u => u.includes('_003_ASHFL_S.grib2.bz2'))).toBe(true);

    // Acquire hour 5 next: static HSURF/HHL and f004 flux companions must be reused from memory,
    // while f005 T and P model levels are freshly acquired!
    const frame5 = await session.acquire(5);
    expect(requestedUrls.filter(u => u.includes('_HSURF.grib2.bz2')).length).toBe(1);
    expect(requestedUrls.filter(u => u.includes('_HHL.grib2.bz2')).length).toBe(
      ICON_EU_HALF_LEVELS.length
    );
    expect(requestedUrls.filter(u => u.includes('_004_ASHFL_S.grib2.bz2')).length).toBe(1);
    expect(frame5.tempK[0]![0]).toBeCloseTo(290.5, 4);
    expect(frame4.tempK[0]![0]).toBeCloseTo(290.4, 4);

    // Discard disk flux objects, then jump to an earlier frame. Older decoded pairs
    // must have been released; the last completed pair alone remains reusable.
    for (const name of await readdir(join(cacheDir, 'objects'))) {
      if (/_A[SL]HFL_S\.grib2\.bz2$/.test(name)) await rm(join(cacheDir, 'objects', name));
    }
    await session.acquire(4);
    expect(requestedUrls.filter(u => u.includes('_003_ASHFL_S.grib2.bz2'))).toHaveLength(2);
    expect(requestedUrls.filter(u => u.includes('_004_ASHFL_S.grib2.bz2'))).toHaveLength(2);

    // Derive the lift-only ICON-EU frame and verify per-column pressure screening works
    const maskBytes = Math.ceil((ICON_EU_GRID.width * ICON_EU_GRID.height) / 8);
    const mask: CoverageMask = {
      grid: ICON_EU_GRID,
      bounds: ICON_EU_PRODUCT.bounds,
      output: new Uint8Array(maskBytes),
      halo: new Uint8Array(maskBytes),
      tiles: Uint8Array.of(1),
      maxZoom: 0
    };
    setBit(mask.output, 0);
    setBit(mask.halo, 1);
    const fields = deriveFrame(frame4, mask, {
      layers: ICON_EU_PRODUCT.layers,
      daylightOnly: false
    });
    expect(fields['precip-rate']).toBeUndefined();
    expect(fields['usable-lift-msl']!.flags[0] & STATUS_MASK).toBe(STATUS_VALID);
    expect(fields['usable-lift-agl']!.flags[0] & STATUS_MASK).toBe(STATUS_VALID);
    await session.close();
  });

  it.each(['decode', 'metadata'])('recovers from %s failures without preserving poisoned disk cache entries', async kind => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-repair-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z', requested: string[] = [];
    const good = syntheticFetch(cycle, requested);
    const invalid = kind === 'decode' ? Uint8Array.of(1, 2, 3) : buildSyntheticIconGrib2({
      centre: 79, referenceTimeIso: cycle, templateNumber: 0, parameterCategory: 3,
      parameterNumber: 6, firstFixedSurfaceType: 1, firstFixedSurfaceValue: null,
      secondFixedSurfaceType: 101, hour: 0, constantValue: 1000
    });
    let attempts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).endsWith('_HSURF.grib2.bz2') && attempts++ === 0) return new Response(Buffer.from(invalid));
      return good(input, init);
    };
    const options = { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl };
    const first = await createIconEuAcquisitionSession(options);
    await first.acquire(4);
    expect(attempts).toBe(2);
    expect(first.stats.retries).toBe(1);
    await first.close();

    const name = (await readdir(join(cacheDir, 'objects'))).find(name => name.endsWith('_HSURF.grib2.bz2'))!;
    await writeFile(join(cacheDir, 'objects', name), invalid);
    const second = await createIconEuAcquisitionSession(options);
    await second.acquire(5);
    expect(attempts).toBe(3);
    expect(second.stats.cacheHits).toBeGreaterThan(0);
    await second.close();
  });

  it('leaves no poisoned object behind when all download validation attempts fail', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-invalid-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('invalid GRIB'));
    const session = await createIconEuAcquisitionSession({ cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await expect(session.acquire(4)).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it('shares one concurrency bound across surface, temperature and pressure downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-concurrent-'));
    tempDirs.push(cacheDir);
    const cycle = '2026-10-08T00:00:00Z', good = syntheticFetch(cycle, []);
    let active = 0, peak = 0;
    let release = () => {}, reachedLimit = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const occupied = new Promise<void>(resolve => { reachedLimit = resolve; });
    const fetchImpl: typeof fetch = async (input, init) => {
      peak = Math.max(peak, ++active);
      try {
        if (!String(input).includes('time-invariant')) {
          if (active === 2) reachedLimit();
          await gate;
        }
        return await good(input, init);
      } finally { active--; }
    };
    const options = { cycle, activeIndices: Uint32Array.of(0), cacheDir, fetchImpl, concurrency: 2 };
    const session = await createIconEuAcquisitionSession(options);
    const frame = session.acquire(4);
    await expect(session.acquire(5)).rejects.toThrow('active frame');
    await occupied;
    expect(active).toBe(2);
    release();
    await frame;
    expect(peak).toBe(2);
    expect(active).toBe(0);
    await session.close();
    for (const concurrency of [0, 1.5, 9, NaN]) {
      await expect(createIconEuAcquisitionSession({ ...options, concurrency })).rejects.toThrow('concurrency');
    }
  });

  it('keeps closed sessions closed without starting new downloads', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-closed-'));
    tempDirs.push(cacheDir);
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('Unexpected download'); });
    const session = await createIconEuAcquisitionSession({ cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await session.close();
    await session.close();
    await expect(session.acquire(4)).rejects.toThrow('session is closed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['close', 'external abort'])('drains an active download after %s before close resolves', async mode => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-close-active-'));
    tempDirs.push(cacheDir);
    const controller = new AbortController();
    const reason = mode === 'close' ? 'session is closed' : 'Cancelled externally';
    let started = () => {}, aborted = () => {}, release = () => {};
    const fetching = new Promise<void>(resolve => { started = resolve; });
    const cancelled = new Promise<void>(resolve => { aborted = resolve; });
    const drain = new Promise<void>(resolve => { release = resolve; });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const signal = init!.signal!;
      started();
      await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      await drain;
      signal.throwIfAborted();
      throw new Error('Expected cancellation');
    });
    const session = await createIconEuAcquisitionSession({ cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl, signal: controller.signal });
    const acquisition = expect(session.acquire(4)).rejects.toThrow(reason);
    await fetching;
    let closed = false;
    if (mode === 'external abort') controller.abort(new Error(reason));
    const closing = session.close().then(() => { closed = true; });
    await cancelled;
    expect(closed).toBe(false);
    await expect(session.acquire(5)).rejects.toThrow(reason);
    release();
    await Promise.all([closing, acquisition]);
    expect(closed).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it.each(['declared', 'streamed'])('rejects and cancels an oversized %s download before caching it', async kind => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'av-icon-oversize-'));
    tempDirs.push(cacheDir);
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel
    }), { headers: kind === 'declared' ? { 'content-length': String(8 * 1024 * 1024 + 1) } : undefined }));
    const session = await createIconEuAcquisitionSession({ cycle: '2026-10-08T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir, fetchImpl });
    await expect(session.acquire(4)).rejects.toThrow('byte length');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(cancel).toHaveBeenCalledTimes(3);
    expect(await readdir(cacheDir)).toEqual([]);
    await session.close();
  });

  it('loads the bundled icon-eu-land-v1 coverage mask, passes build admission, and filters dark regional hours before acquisition', async () => {
    const mask = await loadCoverage(ICON_EU_PRODUCT);
    const indices = coverageIndices(mask);
    const layout = prepareSamplePackLayout(mask.grid, mask.output, mask.halo);
    expect(indices.output.length).toBe(454836);
    expect(indices.active.length).toBe(465559);
    expect(layout.storedCells).toBe(596769);

    const daylightHours = resolveProductFrameHours(
      ICON_EU_PRODUCT,
      mask,
      '2026-10-08T00:00:00Z',
      { outputIndices: indices.output }
    );
    // Night hours over Europe (00..01 UTC and 19..24 UTC in October) are omitted before acquisition
    expect(daylightHours).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    const { capacity } = prepareBuild(mask, ICON_EU_PRODUCT, {
      ...iconEuProvider,
      frameCount: daylightHours.length
    });
    expect(capacity.violations).toEqual([]);
    expect(capacity.tilesByZoom).toEqual([1, 2, 4, 8, 16, 45, 143, 485, 1691]);
  });

  it.skipIf(!PROBE_DIR)(
    'decodes six retained DWD ICON-EU .grib2.bz2 fields (bzip2 + DRT 5.42 CCSDS) and matches ecCodes/libaec reference values',
    () => {
      // Yerevan grid point: sourceRow = 171 (from 29.5N), col = 1088 (from -23.5E)
      // Normalized north-to-south row = 656 - 171 = 485 -> flat index = 485 * 1377 + 1088 = 668933
      const yerevanNormalizedIdx = (ICON_EU_GRID.height - 1 - 171) * ICON_EU_GRID.width + 1088;
      const active = Uint32Array.of(yerevanNormalizedIdx);
      const cycle = '2026-10-08T00:00:00Z';

      const manifest = JSON.parse(readFileSync(join(PROBE_DIR!, 'manifest.json'), 'utf8')) as {
        samples: { filename: string; receipt: { sha256: string; bytes: number } }[];
      };
      const loadReal = (filename: string) => {
        const compressed = new Uint8Array(readFileSync(join(PROBE_DIR!, filename)));
        const receipt = manifest.samples.find(sample => sample.filename === filename)?.receipt;
        expect(receipt?.bytes).toBe(compressed.byteLength);
        expect(receipt?.sha256).toBe(createHash('sha256').update(compressed).digest('hex'));
        expect(isBzip2Compressed(compressed)).toBe(true);
        return decodeIconGribField(compressed, active);
      };

      const hsurf = loadReal('icon-eu_europe_regular-lat-lon_time-invariant_2026100800_HSURF.grib2.bz2');
      verifyIconFieldMetadata(hsurf, 'HSURF', cycle);
      expect(hsurf.values[0]).toBeCloseTo(1059.875, 4);

      const hhl75 = loadReal('icon-eu_europe_regular-lat-lon_time-invariant_2026100800_75_HHL.grib2.bz2');
      verifyIconFieldMetadata(hhl75, 'HHL', cycle, { level: 75 });
      expect(hhl75.values[0]).toBeCloseTo(1059.875, 4);

      const p74 = loadReal('icon-eu_europe_regular-lat-lon_model-level_2026100800_006_74_P.grib2.bz2');
      verifyIconFieldMetadata(p74, 'P', cycle, { hour: 6, level: 74 });
      expect(p74.values[0]).toBeCloseTo(90410.921875, 2);

      const t74 = loadReal('icon-eu_europe_regular-lat-lon_model-level_2026100800_006_74_T.grib2.bz2');
      verifyIconFieldMetadata(t74, 'T', cycle, { hour: 6, level: 74 });
      expect(t74.values[0]).toBeCloseTo(288.935883, 4);

      const mh = loadReal('icon-eu_europe_regular-lat-lon_single-level_2026100800_006_MH.grib2.bz2');
      verifyIconFieldMetadata(mh, 'MH', cycle, { hour: 6 });
      expect(mh.values[0]).toBeCloseTo(200.0, 4);

      const ashfl = loadReal('icon-eu_europe_regular-lat-lon_single-level_2026100800_006_ASHFL_S.grib2.bz2');
      verifyIconFieldMetadata(ashfl, 'ASHFL_S', cycle, { hour: 6 });
      expect(ashfl.values[0]).toBeCloseTo(11.42572, 4);
    }
  );
});
