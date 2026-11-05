import type { ElevationGrid, TerrainBounds } from '@av/contracts';
import { TERRAIN_BATCH_POINTS } from '../contract.ts';
import { TERRAIN_READ_LIMITS, type TerrainReader } from '../reader.ts';

const SAMPLES_PER_DEGREE = 1200;

/** Read native-scale DEM nodes as a north-up pixel-edge grid within the reader's output budget. */
export async function readSolarElevationGrid(reader: TerrainReader, bounds: TerrainBounds): Promise<ElevationGrid> {
  if (![bounds.south, bounds.west, bounds.north, bounds.east].every(Number.isFinite)
    || bounds.south < -90 || bounds.north > 90 || bounds.south > bounds.north || bounds.west > bounds.east
    || bounds.east - bounds.west > 360) throw new Error('Invalid solar elevation bounds');
  if (!reader.sampleBatch) throw new Error('Solar terrain requires a batched elevation reader');
  const column = Math.floor(bounds.west * SAMPLES_PER_DEGREE), row = Math.ceil(bounds.north * SAMPLES_PER_DEGREE);
  const width = Math.ceil(bounds.east * SAMPLES_PER_DEGREE) - column + 1;
  const height = row - Math.floor(bounds.south * SAMPLES_PER_DEGREE) + 1, cells = width * height;
  if (!Number.isSafeInteger(cells) || cells < 1 || cells > TERRAIN_READ_LIMITS.maxOutputPixels - reader.stats().outputPixels) throw new Error('Solar elevation output budget exceeded');
  const values = new Float32Array(cells).fill(NaN);
  for (let start = 0; start < cells; start += TERRAIN_BATCH_POINTS) {
    const count = Math.min(TERRAIN_BATCH_POINTS, cells - start);
    const points = Array.from({ length: count }, (_, index) => {
      const offset = start + index, longitude = (column + offset % width) / SAMPLES_PER_DEGREE;
      return { latitude: (row - Math.floor(offset / width)) / SAMPLES_PER_DEGREE,
        longitude: ((longitude + 180) % 360 + 360) % 360 - 180 };
    });
    const samples = await reader.sampleBatch(points);
    if (samples.length !== count) throw new Error('Incomplete solar elevation batch');
    for (let index = 0; index < count; index++) if (samples[index]) values[start + index] = samples[index]!.elevationM;
  }
  const step = 1 / SAMPLES_PER_DEGREE;
  return { values, width, height, west: column / SAMPLES_PER_DEGREE - step / 2,
    north: row / SAMPLES_PER_DEGREE + step / 2, dLon: step, dLat: step };
}
