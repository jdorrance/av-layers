import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { prepareGridGeometry } from '@av/contracts/geometry';
import { sparseCoverageFromDense, type ManifestV5 } from '@av/contracts';
import { STATUS_OUTSIDE, STATUS_VALID } from '@av/contracts/layers';
import { decodePackedWindChunk, encodeWindColumns, normalizedWindColumn, samplePackedWindColumns } from '@av/forecast/wind';
import { fixtureBuild } from '../../../tests/forecast-fixture.js';
import { getForecastProvider } from './providers.js';
import { localForecastSource } from './local-source.js';
import { sourceModelId } from './source.js';
import { createWindDataWriter, localWindData } from './wind-data.js';
import type { WholeDomainPrepared } from './whole-domain/prepare.js';

type Column = ReturnType<typeof normalizedWindColumn>;
function decodeColumns(bytes: Uint8Array): (Column | null)[] {
  const { view, count, levels } = decodePackedWindChunk(bytes);
  return Array.from({ length: count }, (_, i) => {
    const start = 12 + i * (9 + 13 * levels), status = view.getUint8(start + 8);
    if (status === STATUS_OUTSIDE) return null;
    const vector = (offset: number) => view.getUint8(offset + 8) === STATUS_VALID ? { u: view.getFloat32(offset, true), v: view.getFloat32(offset + 4, true) } : null;
    return { surface: vector(start), levels: Array.from({ length: levels }, (_, j) => {
      const offset = start + 9 + j * 13, wind = vector(offset + 4);
      return wind ? { height: view.getFloat32(offset, true), wind } : null;
    }) };
  });
}

function windAtHeight(column: Column, height: number) {
  for (let i = 0; i < column.levels.length; i++) {
    const a = column.levels[i], b = column.levels[i + 1];
    if (a && height === a.height) return a.wind;
    if (a && b && a.height < height && height < b.height) {
      const t = (height - a.height) / (b.height - a.height);
      return { u: a.wind.u + t * (b.wind.u - a.wind.u), v: a.wind.v + t * (b.wind.v - a.wind.v) };
    }
  }
  return null;
}

const realCases = [
  { model: 'gfs', enabled: !!process.env.AV_REAL_WIND_TEST, cycle: '2026-11-03T12:00:00.000Z', hour: 4, lat: 40, lon: -100 },
  { model: 'av-wrf', enabled: !!process.env.AV_REAL_WRF_STORE, cycle: '2026-11-13T00:00:00.000Z', hour: 6, lat: 40.5, lon: 44.5 }
] as const;

for (const testCase of realCases) it.skipIf(!testCase.enabled)(`round-trips real ${testCase.model} winds through the encoder and API without network`, async () => {
  const product = getProduct(testCase.model)!, point = prepareGridGeometry(product.grid).geographicToGrid(testCase.lat, testCase.lon)!;
  const x = Math.floor(point.x) - 3, y = Math.floor(point.y) - 3;
  const activeIndices = Uint32Array.from(Array.from({ length: 64 }, (_, i) => (y + Math.floor(i / 8)) * product.grid.width + (x + i % 8)));
  const provider = getForecastProvider(testCase.model);
  const store = testCase.model === 'av-wrf' ? localForecastSource(process.env.AV_REAL_WRF_STORE!, sourceModelId(product)) : undefined;
  const session = await provider.open({ cycle: testCase.cycle, cacheDir: `.cache/${testCase.model}`, activeIndices,
    ...(store ? { store } : { offline: true, readOnlyCache: true }) });
  try {
    const frame = await session.acquire(testCase.hour), original = Array.from(activeIndices, (_, i) => normalizedWindColumn(frame, i));
    const bytes = encodeWindColumns(original), decoded = decodeColumns(bytes), chunk = decodePackedWindChunk(bytes);
    expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
    expect(decoded).toEqual(original);
    expect(decoded.filter(column => column?.surface)).not.toHaveLength(0);
    for (let i = 0; i < original.length; i++) {
      for (const agl of [600, 1200, 3000, 6000]) {
        const height = frame.terrainM[i] + agl;
        expect(windAtHeight(decoded[i]!, height)).toEqual(windAtHeight(original[i], height));
        const result = samplePackedWindColumns({ contributors: [{ index: i, row: 0, column: i, weight: 1 }], byteRange: { offset: 0, length: 0 } }, [chunk], [i], height);
        const expected = windAtHeight(original[i], height);
        expect({ u: result.u, v: result.v }).toEqual(expected ?? { u: null, v: null });
      }
    }
    const grid = product.grid.kind === 'regular-latlon'
      ? { ...product.grid, width: 8, height: 8, lon0: product.grid.lon0 + x * product.grid.dx, lat0: product.grid.lat0 + y * product.grid.dy, wrapLongitude: false }
      : { ...product.grid, width: 8, height: 8, x0M: product.grid.x0M + x * product.grid.dxM, y0M: product.grid.y0M + y * product.grid.dyM };
    const coverage = sparseCoverageFromDense({ width: 8, height: 8, wrapLongitude: false, gridHash: 'a'.repeat(64), output: new Uint8Array(8).fill(255), halo: new Uint8Array(8) });
    const prepared = { plan: { native: grid, fine: grid }, fine: { mask: { coverage } } } as unknown as WholeDomainPrepared;
    const cropped = { ...frame, grid, activeIndices: Uint32Array.from({ length: 64 }, (_, i) => i) };
    const out = await mkdtemp(join(tmpdir(), 'av-real-wind-'));
    try {
      const manifest = fixtureBuild({ model: testCase.model }).manifest;
      manifest.cycle = frame.cycle; manifest.expiresAt = new Date(Date.parse(frame.validAt) + 24 * 3_600_000).toISOString();
      manifest.frames = [manifest.frames[0]]; manifest.mapFrameCount = 1;
      for (const surface of manifest.surfaces) surface.grid = grid;
      const writer = createWindDataWriter(out, manifest.model, manifest.buildId, provider.maxLevels, prepared.plan, { mapFrames: 1, numericBytes: 0, estimatedPeakBytes: 0 });
      await writer.writeFrame(cropped, manifest.frames[0].id, { values: Float32Array.from(frame.terrainM, value => value + 1000), flags: new Uint8Array(64) }, prepared, { elevationM: frame.terrainM, valid: Uint8Array.from(frame.missing.terrain, value => value ? 0 : 1) });
      const reference = await writer.finish(), data = await localWindData(out, manifest);
      expect(data?.reference).toEqual(reference);
      const bucket = { async get(key: string, options?: { range?: { offset: number; length: number } }) {
        const object = data!.objects.find(item => item.key === key);
        if (!object) return null;
        const file = await readFile(join(out, key)), range = options?.range;
        const part = Uint8Array.from(range ? file.subarray(range.offset, range.offset + range.length) : file);
        return { size: file.length, range, customMetadata: { sha256: object.sha256 }, body: new ReadableStream({ start(controller) { controller.enqueue(part); controller.close(); } }) };
      } };
      const modulePath = '../../api/src/wind-data.js';
      const api = await import(modulePath) as { windChunk(bucket: unknown, manifest: ManifestV5, entry: unknown, frame: string, kind: 'wind', tile: number, ctx: unknown, signal: AbortSignal): Promise<Uint8Array> };
      vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(frame.validAt);
      const entry = { buildId: manifest.buildId, manifestKey: `builds/${manifest.model}/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt, mapData: reference };
      const served = decodeColumns(await api.windChunk(bucket, manifest, entry, manifest.frames[0].id, 'wind', 0, { waitUntil() {} }, new AbortController().signal));
      for (let i = 0; i < 64; i++) expect(served[Math.floor(i / 8) * 16 + i % 8]).toEqual(original[i]);
    } finally { vi.useRealTimers(); await rm(out, { recursive: true, force: true }); }
  } finally { await session.close(); }
}, 120_000);
