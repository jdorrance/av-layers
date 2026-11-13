import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { expect, it, vi } from 'vitest';
import { geographicToGrid, type Grid, type LambertConformalGrid, type ModelDefinition } from '@av/contracts';
import { parseFields, sampleFieldValuesAsync } from '@azohra/meteo.grib';
import { INDEXED_PRODUCT } from '../../../../tests/model-fixtures.js';
import { NORTHERN_LAMBERT, SOUTHERN_LAMBERT } from '../../../../tests/lambert-fixtures.js';
import { indexedSource } from './source.js';
import { acquireIndexedGribFrame, contractIndexToNativeIndex } from './acquire.js';
import { inspectIndexedGribField } from './admission.js';
import { indexedGribCurrentSpecs, indexedGribFirstFixedSurface } from './fields.js';
import { sha256 } from './transport.js';
import type { IndexedGribFieldSpec } from './types.js';

const fixture = 'rrfs-shtfl-mean-7-8h-sparse';
const expected: { grid: Grid; fixtureSha256: string; metadataSha256: string; points: { name: string; index: number; latitude: number; longitude: number; valueWm2: number }[] } =
  JSON.parse(await readFile(new URL(`./fixtures/${fixture}.expect.json`, import.meta.url), 'utf8'));
const bytes = gunzipSync(await readFile(new URL(`./fixtures/${fixture}.grib2.gz`, import.meta.url)));
const model: ModelDefinition = {
  ...INDEXED_PRODUCT, modelId: 'projected-source', grid: expected.grid,
  capabilities: { ...INDEXED_PRODUCT.capabilities, maxVerticalLevels: 1 },
  forecast: { hours: [8], intervalHours: 1, cycleHoursUtc: [0], statisticsResetHours: 1 },
  upstream: { ...INDEXED_PRODUCT.upstream, nativeLongitudeOrigin: undefined,
    urlTemplate: 'https://source.invalid/{product}/f{hour}', products: { surface: '2dfld', pressure: 'prslev' },
    surfaceProduct: 'surface', pressureLevelsHpa: { pressure: [850] } },
};
const profile = indexedSource(model), cycle = '2026-11-05T00:00:00Z';
const specs = indexedGribCurrentSpecs(profile, 8);
const spec = specs.find(field => field.kind === 'sensible-flux')!;
const options = { cycle, spec, expectedStartHour: 7, expectedEndHour: 8 };

it('admits original Lambert headers and samples four real signed values in native cell order', async () => {
  const admitted = inspectIndexedGribField(profile, bytes, options);
  expect(sha256(bytes)).toBe(expected.fixtureSha256);
  expect(admitted.receipt.metadataSha256).toBe(expected.metadataSha256);
  expect(admitted.receipt).toMatchObject({ grid: { kind: 'lambert', gridDefinitionTemplateNumber: 30, scanningMode: 64 },
    interval: { kind: 'window', start: '2026-11-05T07:00:00.000Z', end: '2026-11-05T08:00:00.000Z', process: 0 } });
  for (const point of expected.points) {
    const coordinate = geographicToGrid(profile.grid, point.latitude, point.longitude)!;
    expect(coordinate.x).toBeCloseTo(point.index % profile.grid.width, 8);
    expect(coordinate.y).toBeCloseTo(Math.floor(point.index / profile.grid.width), 8);
    expect(contractIndexToNativeIndex(profile, point.index)).toBe(point.index);
  }
  const sampled = await sampleFieldValuesAsync(admitted.field, Uint32Array.from([0, ...expected.points.map(point => point.index)]));
  expect(sampled.missingMask?.[0]).toBe(1);
  expect([...sampled.values.slice(1)]).toEqual(expected.points.map(point => point.valueWm2));
  for (const index of [0, profile.grid.width - 1, profile.grid.width, profile.grid.width * profile.grid.height - 1]) {
    expect(contractIndexToNativeIndex(profile, index)).toBe(index);
  }
});

it('requires every configured Lambert geometry fact and refuses unsupported scan layouts', () => {
  if (model.grid.kind !== 'lambert-conformal') throw new Error('Expected projected fixture');
  const grid = model.grid;
  for (const change of [{ width: grid.width - 1 }, { height: grid.height - 1 }, { earthRadiusM: grid.earthRadiusM + 1 },
    { centralMeridianDeg: grid.centralMeridianDeg + 1 }, { latitudeOfOriginDeg: grid.latitudeOfOriginDeg + 1 },
    { standardParallel1Deg: grid.standardParallel1Deg + 1 }, { standardParallel2Deg: grid.standardParallel2Deg + 1 },
    { x0M: grid.x0M + 1 }, { y0M: grid.y0M + grid.dyM }, { dxM: -grid.dxM }, { dyM: -grid.dyM }]) {
    expect(() => inspectIndexedGribField(indexedSource({ ...model, grid: { ...grid, ...change } }), bytes, options)).toThrow(/grid|earth|Lambert/i);
  }
  for (const scanning of [0, 65, 80, 96, 192]) {
    const copy = Buffer.from(bytes), section = parseFields(copy)[0]!.section3;
    section[64] = scanning;
    expect(() => inspectIndexedGribField(profile, copy, options)).toThrow(/grid|Lambert/i);
  }
  expect(() => indexedSource({ ...model, upstream: { ...model.upstream, nativeLongitudeOrigin: 0 } })).toThrow(/first cell/);
  const { nativeLongitudeOrigin: _origin, ...regularUpstream } = INDEXED_PRODUCT.upstream;
  expect(() => indexedSource({ ...INDEXED_PRODUCT, upstream: regularUpstream })).toThrow(/requires a native longitude origin/);
});

function projectedField(grid: LambertConformalGrid, firstLat: number, firstLon: number, pole: number) {
  const copy = Buffer.from(bytes), { section3 } = parseFields(copy)[0]!;
  const section = Buffer.from(section3.buffer, section3.byteOffset, section3.byteLength);
  const angle = (offset: number, degrees: number) => {
    const magnitude = Math.round(Math.abs(degrees) * 1e6);
    section.writeUInt32BE(degrees < 0 ? 0x80000000 + magnitude : magnitude, offset);
  };
  section.writeUInt32BE(grid.width * grid.height, 6);
  section[14] = grid.earthRadiusM === 6371229 ? 6 : 1;
  section[15] = 0;
  section.writeUInt32BE(grid.earthRadiusM, 16);
  section.writeUInt32BE(grid.width, 30);
  section.writeUInt32BE(grid.height, 34);
  angle(38, firstLat);
  angle(42, firstLon);
  angle(47, grid.latitudeOfOriginDeg);
  angle(51, grid.centralMeridianDeg);
  section.writeUInt32BE(grid.dxM * 1000, 55);
  section.writeUInt32BE(grid.dyM * 1000, 59);
  section[63] = pole;
  section[64] = 64;
  angle(65, grid.standardParallel1Deg);
  angle(69, grid.standardParallel2Deg);
  section.fill(0, 73, 81);
  return { copy, section };
}

// First cells from PROJ 9.6.0 `proj -I`, then rounded to GRIB2 microdegrees.
it.each([
  { name: 'Northern UPP', grid: { ...NORTHERN_LAMBERT, earthRadiusM: 6371229, latitudeOfOriginDeg: 39 },
    firstLat: 36.936305558247, firstLon: 41.465860843988, pole: 0 },
  { name: 'New Zealand with an explicit Earth radius', grid: SOUTHERN_LAMBERT,
    firstLat: -47.959521734691, firstLon: 164.479954540709, pole: 128 },
  { name: 'a southern cone with a northern projection origin', grid: { ...SOUTHERN_LAMBERT, latitudeOfOriginDeg: 2 },
    firstLat: -3.491826927915, firstLon: 168.048475396235, pole: 128 }
])('admits quantized Lambert first cells for $name and rejects altered geometry', ({ grid, firstLat, firstLon, pole }) => {
  const { copy, section } = projectedField(grid, firstLat, firstLon, pole);
  const defaultPole = indexedSource({ ...model, grid });
  expect(() => inspectIndexedGribField(defaultPole, copy, options)).toThrow(/Lambert geometry/);
  const source = indexedSource({ ...model, grid, upstream: { ...model.upstream, lambertSouthPoleLatitude: 0 } });
  const admitted = inspectIndexedGribField(source, copy, options);
  expect(admitted.grid).toMatchObject({ kind: 'lambert', projectionCentreFlag: pole, southPoleLatitude: 0 });
  const first = source.geometry.geographicToGrid(admitted.grid.latitudeOfFirstGridPoint, admitted.grid.longitudeOfFirstGridPoint)!;
  expect(Math.hypot(first.x * grid.dxM, first.y * grid.dyM)).toBeGreaterThan(0.003);
  for (const invalidFlag of [pole ^ 0x80, pole | 0x40, pole | 0x01]) {
    section[63] = invalidFlag;
    expect(() => inspectIndexedGribField(source, copy, options)).toThrow(/Lambert geometry/);
  }
  section[63] = pole;
  section.writeUInt32BE(0x80000000 + 90_000_000, 73);
  expect(inspectIndexedGribField(defaultPole, copy, options).grid).toMatchObject({ southPoleLatitude: -90 });
  expect(() => inspectIndexedGribField(source, copy, options)).toThrow(/Lambert geometry/);
  section.writeUInt32BE(0, 73);
  const origin = section.readUInt32BE(47);
  section.writeUInt32BE(origin + 1, 47);
  expect(() => inspectIndexedGribField(source, copy, options)).toThrow(/Lambert geometry/);
  section.writeUInt32BE(origin, 47);
  section.writeUInt32BE(section.readUInt32BE(42) + 10, 42);
  expect(() => inspectIndexedGribField(source, copy, options)).toThrow(/Lambert first cell/);
});

it('checks the GRIB producer subcentre when the source config specifies it', () => {
  const { subCentre } = parseFields(bytes)[0]!.identification;
  const sourceWith = (subCentre: number) => indexedSource({ ...model, upstream: { ...model.upstream, subCentre } });
  expect(inspectIndexedGribField(sourceWith(subCentre), bytes, options).receipt.identification.subCentre).toBe(subCentre);
  expect(() => inspectIndexedGribField(sourceWith((subCentre + 1) % 65536), bytes, options)).toThrow(/producer/);
  expect(() => sourceWith(65536)).toThrow(/subCentre/);
});

// Preserve the source grid and bitmap; other roles use synthetic constants to exercise full-session admission.
function fieldFor(field: IndexedGribFieldSpec): Buffer {
  const original = parseFields(bytes)[0]!, section4 = Buffer.from(original.section4.subarray(0, field.statistic === 'instant' ? 34 : undefined));
  section4.writeUInt32BE(section4.length); section4.writeUInt16BE(field.statistic === 'instant' ? 0 : 8, 7);
  const parameter = profile.upstream.parameters[field.variable]!;
  section4[9] = parameter[0]; section4[10] = parameter[1];
  section4.writeUInt32BE(field.statistic === 'instant' ? 8 : 7, 18);
  const [surface, value] = indexedGribFirstFixedSurface(field.level);
  section4[22] = surface; section4[23] = 0; section4.writeUInt32BE(value, 24);
  if (field.statistic !== 'instant') section4[46] = field.statistic === 'mean' ? 0 : 1;
  const constant = field.kind === 'surface-pressure' ? 100000 : field.kind === 'spfh-2m' ? 0.01
    : field.kind === 'temp-2m' || field.kind === 'temperature' ? 280 : field.kind === 'precipitation' ? 2.4 : 100;
  const section5 = Buffer.from(original.section5), section7 = Buffer.alloc(5);
  section7.writeUInt32BE(5); section7[4] = 7;
  section5.writeFloatBE(constant, 11); section5.writeUInt16BE(0, 17); section5[19] = 0;
  const parts = [original.section1, original.section3, section4,
    field.kind === 'sensible-flux' ? original.section5 : section5, original.section6!,
    field.kind === 'sensible-flux' ? original.section7 : section7];
  const header = Buffer.from(bytes.subarray(0, 16));
  header.writeBigUInt64BE(BigInt(20 + parts.reduce((sum, part) => sum + part.length, 0)), 8);
  return Buffer.concat([header, ...parts, Buffer.from('7777')]);
}

it('acquires a projected frame with independent product routes, honest one-hour windows and projected receipts', async () => {
  const files = new Map(Object.entries(profile.upstream.products).map(([product, file]) => {
    const fields = specs.filter(field => field.product === product).map(field => ({ field, bytes: fieldFor(field), offset: 0 }));
    let offset = 0;
    for (const field of fields) { field.offset = offset; offset += field.bytes.length; }
    const index = fields.map(({ field, offset }, i) => `${i + 1}:${offset}:d=2026110500:${field.variable}:${field.level}:${field.forecast}:`);
    index.push(`${fields.length + 1}:${offset}:d=2026110500:DUMMY:surface:unused:`);
    return [file, { bytes: Buffer.concat(fields.map(field => field.bytes)), index: index.join('\n') }] as const;
  }));
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), file = files.get(url.pathname.split('/')[1]!)!;
    expect(url.pathname).toMatch(/\/f008(?:\.idx)?$/);
    if (url.pathname.endsWith('.idx')) return new Response(file.index);
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get('range')!)!;
    return new Response(Uint8Array.from(file.bytes.subarray(Number(start), Number(end) + 1)), {
      status: 206, headers: { 'content-range': `bytes ${start}-${end}/${file.bytes.length}` } });
  });
  const indices = Uint32Array.from([expected.points[3]!.index, 0, ...expected.points.slice(0, 3).map(point => point.index)]);
  const frame = await acquireIndexedGribFrame(profile, { cycle, hour: 8, activeIndices: indices, fetchImpl });
  expect(frame.grid).toEqual(profile.grid); expect(frame.activeIndices).toEqual(indices);
  expect(frame.sensibleHeatFluxWm2[0]).toBe(Math.fround(expected.points[3]!.valueWm2));
  expect(frame.missing.sensibleHeatFlux).toEqual(Uint8Array.of(0, 1, 0, 0, 0));
  expect(frame.precipitationMmPerHour[0]).toBeCloseTo(2.4);
  expect(frame.intervals).toMatchObject({ usedCompanion: false,
    fluxWindow: { start: '2026-11-05T07:00:00.000Z', end: '2026-11-05T08:00:00.000Z' },
    precipitationWindow: { start: '2026-11-05T07:00:00.000Z', end: '2026-11-05T08:00:00.000Z' } });
  expect(frame.receipt.sourceGrid).toMatchObject({ dxM: 3000, dyM: 3000, laD: 38.5, loV: 262.5, scanningMode: 64 });
  expect(frame.receipt.sourceGrid).not.toHaveProperty('dlon');
  expect(frame.receipt.fields).toHaveLength(specs.length);
  expect(frame.receipt.fields.find(field => field.kind === 'sensible-flux')!.metadataSha256).toBe(expected.metadataSha256);
  expect(fetchImpl).toHaveBeenCalledTimes(specs.length + files.size);
});
