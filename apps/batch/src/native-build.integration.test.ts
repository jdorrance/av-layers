import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PMTiles } from 'pmtiles';
import { GFS_GRID, GFS_PRODUCT, MODEL_IDS, getProduct, gridSchema, manifestSchema, type CoverageMask, type ProductDefinition } from '@av/contracts';
import { packedCellsFromRange, planPackedSample, planSample, prepareSamplePackLayout, sampleCells, sampleGrid } from '@av/forecast';
import fixture from '../../../packages/contracts/src/fixtures/lambert.json';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { buildForecast, deriveFrame } from './build.js';
import { readCoverage } from './coverage.js';
import type { ForecastProvider, NormalizedFrame } from './providers.js';
import { renderTileRgba } from './render.js';
import { localPath, validateBuild } from './validate.js';
import { decodeWebp } from './webp.js';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const CYCLE = '2026-11-01T00:00:00.000Z';

describe('offline native-grid build integration', () => {
  it('rejects invalid product shapes before opening a provider or writing coverage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-product-admission-')); temporary.push(root);
    const grid = gridSchema.parse({ ...GFS_GRID, width: 3, height: 3, lon0: 0, lat0: 1, dx: 1, dy: -1, wrapLongitude: false });
    const base: ProductDefinition = { ...GFS_PRODUCT, grid, maxNativeZoom: 0 };
    const mask: CoverageMask = { grid, bounds: base.bounds, output: Uint8Array.of(255, 1), halo: new Uint8Array(2), tiles: Uint8Array.of(1), maxZoom: 0 };
    const open = vi.fn(async () => { throw new Error('Provider must not open'); });
    const provider: ForecastProvider = { id: 'admission-fixture', provider: 'fixture', maxLevels: 3, open };
    const invalid = [
      { layers: [] }, { layers: ['precip-rate', 'precip-rate'] }, { layers: ['unknown'] }, { layers: ['toString'] },
      { frameHours: [] }, { frameHours: [3, 3] }, { frameHours: [6, 3] }, { frameHours: [1.5] }, { frameHours: [Infinity] }, { frameHours: [NaN] },
      { intervalHours: 0 }, { intervalHours: -1 }, { intervalHours: Infinity }, { intervalHours: NaN }, { intervalHours: 4 }
    ];
    for (const shape of invalid) await expect(buildForecast({ out: root, product: { ...base, ...shape } as ProductDefinition, mask, provider })).rejects.toThrow(/Product requires|Product interval/);
    expect(open).not.toHaveBeenCalled(); expect(await readdir(root)).toEqual([]);
  });

  it.each([
    { name: 'regular', grid: gridSchema.parse({ ...GFS_GRID, width: 3, height: 3, lon0: 10, lat0: 72, dx: 1, dy: -1, wrapLongitude: false }), hours: [1, 2], interval: 1, layers: ['precip-rate'] as const, point: { lat: 71.5, lon: 10.5 }, expectedRain: 1.375 },
    { name: 'lambert', grid: gridSchema.parse(fixture.grid), hours: [3], interval: 3, layers: ['usable-lift-msl', 'precip-rate'] as const, point: { lat: 45, lon: -90 }, expectedRain: 3 + ((757366.5627555264 + 2000000) / 100000) * 0.25 + ((585230.9026221943 + 1000000) / 100000) * 0.5 }
  ])('builds, packs, renders and validates the $name fixture without admitting a live provider', async scenario => {
    const root = await mkdtemp(join(tmpdir(), `av-native-${scenario.name}-`)); temporary.push(root);
    const product: ProductDefinition = {
      ...GFS_PRODUCT, id: `fixture-${scenario.name}`, source: { modelFamily: `fixture-${scenario.name}`, configurationId: 'offline-analytic', domainId: scenario.name },
      label: `Offline ${scenario.name} fixture`, attribution: 'Synthetic infrastructure fixture', coverageDescription: 'Synthetic native-grid cells only; no forecast claims',
      bounds: [-180, -85, 180, 85], grid: scenario.grid, coverageId: `fixture-${scenario.name}`, maxNativeZoom: 0,
      frameHours: scenario.hours, intervalHours: scenario.interval, layers: scenario.layers
    };
    const size = Math.ceil(product.grid.width * product.grid.height / 8);
    const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, output: new Uint8Array(size), halo: new Uint8Array(size), tiles: Uint8Array.of(1), maxZoom: 0 };
    for (let index = 0; index < product.grid.width * product.grid.height; index++) mask.output[index >> 3] |= 1 << (index & 7);
    let closed = false;
    const frames = new Map<number, NormalizedFrame>();
    const provider: ForecastProvider = {
      id: `fixture-${scenario.name}`, provider: 'Synthetic offline fixture', maxLevels: 3,
      async open({ activeIndices }) {
        return { cycle: CYCLE, stats: { fixture: true },
          async acquire(hour) { const frame = normalizedFixtureFrame(product.grid, activeIndices, CYCLE, hour, product.intervalHours); frames.set(hour, frame); return frame; },
          async close() { closed = true; }
        };
      }
    };
    const manifestPath = await buildForecast({ out: root, product, mask, provider });
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')));
    expect(closed).toBe(true);
    expect(manifest.frames).toHaveLength(scenario.hours.length);
    expect(manifest.layers).toEqual(scenario.layers);
    expect(manifest.samples.channelCount).toBe(scenario.hours.length * scenario.layers.length);
    const loadedMask = await readCoverage(root, manifest.coverage.hash);
    expect({ ...loadedMask, output: new Uint8Array(loadedMask.output), halo: new Uint8Array(loadedMask.halo), tiles: new Uint8Array(loadedMask.tiles) }).toEqual(mask);
    await expect(validateBuild(root, manifest, loadedMask, manifest.coverage.hash, product)).resolves.toMatchObject({ buildId: manifest.buildId });
    const alteredMask = { ...loadedMask, output: new Uint8Array(loadedMask.output) };
    alteredMask.output[0] ^= 1;
    await expect(validateBuild(root, manifest, alteredMask, manifest.coverage.hash, product)).rejects.toThrow('Coverage identity mismatch');

    const bytes = await readFile(localPath(root, manifest.samples.key));
    const layout = prepareSamplePackLayout(product.grid, mask.output, mask.halo);
    const plan = planSample(product.grid, scenario.point.lat, scenario.point.lon)!;
    const packed = planPackedSample(layout, plan, manifest.samples.channelCount, Array.from({ length: manifest.samples.channelCount }, (_, i) => i));
    const body = bytes.subarray(packed.byteRange.offset, packed.byteRange.offset + packed.byteRange.length);
    let channel = 0;
    for (const hour of scenario.hours) {
      const fields = deriveFrame(frames.get(hour)!, mask);
      for (const layer of scenario.layers) {
        const actual = sampleCells(plan, packedCellsFromRange(packed, body, channel++), manifest.descriptors.layers[layer]);
        expect(actual).toEqual(sampleGrid(product.grid, fields[layer], scenario.point.lat, scenario.point.lon, manifest.descriptors.layers[layer], mask));
        if (layer === 'precip-rate') expect(actual.value).toBeCloseTo(scenario.expectedRain + hour - scenario.hours[0], 9);
        const artifact = manifest.artifacts.find(item => item.layer === layer && item.frame === `f${String(hour).padStart(3, '0')}`)!;
        const archiveBytes = await readFile(localPath(root, artifact.tilesKey));
        const archive = new PMTiles({ getKey: () => artifact.tilesKey, async getBytes(offset, length) { const selected = archiveBytes.subarray(offset, offset + length); return { data: selected.buffer.slice(selected.byteOffset, selected.byteOffset + selected.byteLength) }; } });
        const tile = await archive.getZxy(0, 0, 0);
        expect(tile).toBeDefined();
        expect((await decodeWebp(new Uint8Array(tile!.data))).data).toEqual(renderTileRgba(fields[layer], mask, layer, 0, 0, 0));
      }
    }
    expect(MODEL_IDS).toEqual(['gfs']);
    expect(getProduct(product.source.modelFamily)).toBeUndefined();
  }, 30000);
});
