import { expect, it, vi } from 'vitest';
import { TERRAIN_BATCH_POINTS } from '../contract.ts';
import { TERRAIN_READ_LIMITS, type TerrainReader } from '../reader.ts';
import { sampleGrid } from './grid.ts';
import { readSolarElevationGrid } from './glo90.ts';

function fixture(initial = 0) {
  let outputPixels = initial;
  const sampleBatch = vi.fn<NonNullable<TerrainReader['sampleBatch']>>(async points => {
    outputPixels += points.length;
    return points.map(point => point.longitude < 0 ? null : { elevationM: point.latitude + point.longitude, source: 'dem' });
  });
  const reader = { sampleBatch, stats: () => ({ requests: 0, bytesRead: 0, readBytesBound: 0, decodedPixels: 0, outputPixels, cacheHits: 0 }) } as unknown as TerrainReader;
  return { reader, sampleBatch };
}

it('keeps native nodes at pixel centres, samples bounded chunks and preserves missing values', async () => {
  const { reader, sampleBatch } = fixture();
  const grid = await readSolarElevationGrid(reader, { south: 40, west: 44, north: 40.1, east: 44.1 });
  const calls = sampleBatch.mock.calls.flatMap(([points]) => points);
  expect(sampleBatch.mock.calls.length).toBeGreaterThan(1);
  expect(Math.max(...sampleBatch.mock.calls.map(([points]) => points.length))).toBe(TERRAIN_BATCH_POINTS);
  expect(calls).toHaveLength(grid.values.length);
  expect(calls[0]!.latitude).toBeCloseTo(grid.north - grid.dLat / 2, 12);
  expect(calls[0]!.longitude).toBeCloseTo(grid.west + grid.dLon / 2, 12);
  expect(grid.dLon).toBe(3 / 3600);
  expect(sampleGrid(grid, 40.05, 44.05)).toBeCloseTo(84.1, 4);
  const missing = await readSolarElevationGrid(reader, { south: 0, west: -0.001, north: 0, east: 0 });
  expect([...missing.values].slice(0, -1).every(Number.isNaN)).toBe(true);
  expect(missing.values.at(-1)).toBe(0);
});

it('wraps sampled longitudes while retaining the unwrapped raster branch', async () => {
  const { reader, sampleBatch } = fixture();
  const grid = await readSolarElevationGrid(reader, { south: 0, west: 179.999, north: 0.001, east: 180.001 });
  const points = sampleBatch.mock.calls.flatMap(([points]) => points);
  expect(grid.west).toBeGreaterThan(179);
  expect(points.some(point => point.longitude < -179)).toBe(true);
  expect(points.every(point => point.longitude >= -180 && point.longitude < 180)).toBe(true);
});

it('rejects the output budget before sampling or allocating a full coordinate grid', async () => {
  const { reader, sampleBatch } = fixture();
  await expect(readSolarElevationGrid(reader, { south: 0, west: 0, north: 2, east: 2 })).rejects.toThrow('output budget');
  expect(sampleBatch).not.toHaveBeenCalled();
  const remaining = fixture(TERRAIN_READ_LIMITS.maxOutputPixels - 1);
  await expect(readSolarElevationGrid(remaining.reader, { south: 0, west: 0, north: 0, east: 0.001 })).rejects.toThrow('output budget');
  expect(remaining.sampleBatch).not.toHaveBeenCalled();
});

it('rejects malformed bounds and an incomplete reader batch', async () => {
  const { reader, sampleBatch } = fixture();
  await expect(readSolarElevationGrid(reader, { south: 1, west: 0, north: 0, east: 1 })).rejects.toThrow('bounds');
  expect(sampleBatch).not.toHaveBeenCalled();
  sampleBatch.mockResolvedValue([]);
  await expect(readSolarElevationGrid(reader, { south: 0, west: 0, north: 0, east: 0 })).rejects.toThrow('Incomplete');
});
