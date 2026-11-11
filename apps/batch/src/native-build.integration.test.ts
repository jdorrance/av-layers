import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { getProduct } from '@av/contracts/models';
import { gridSchema, manifestV5Schema, type Grid, type ManifestV5, type ProductDefinition } from '@av/contracts';
import { packedCellsFromRange, planSample, planShardedPackedSample, prepareShardedSamplePackLayout, readProfileRecord, sampleCells } from '@av/forecast';
import type { ModelLevelFrame } from '@av/forecast/inputs';
import lambert from '../../../packages/contracts/src/fixtures/lambert.json' with { type: 'json' };
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { denseFixtureMask, syntheticWholeDomain } from '../../../scripts/fixtures/whole-domain.js';
import { tilePixels } from '../parallel-fixtures.js';
import { buildForecast } from './build.js';
import { buildShard, createBuildPlan, finalizeBuild } from './parallel.js';
import type { ForecastProvider } from './provider.js';
import { assertValidatedBuild, sha256 } from './validate.js';
import { nativeSparseMask } from './whole-domain/coverage.js';
import golden from './whole-domain/fixtures/golden-parity.json' with { type: 'json' };

const roots: string[] = [];
async function temporaryRoot() {
  const root = await mkdtemp(join(tmpdir(), 'av-whole-domain-parity-'));
  roots.push(root);
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const CYCLE = '2026-06-21T12:00:00.000Z';
const wrapping: Grid = { kind: 'regular-latlon', width: 18, height: 3, earthRadiusM: 6371229, lon0: -180, lat0: 72, dx: 20, dy: -1, wrapLongitude: true };
const regional: Grid = { ...wrapping, width: 3, lon0: 10, dx: 1, wrapLongitude: false };

function configured(model: string, grid: Grid, bounds: ProductDefinition['bounds']): ProductDefinition {
  const source = getProduct(model)!;
  const layers = source.layers.filter(layer => ['usable-lift-msl', 'usable-lift-agl', 'precip-rate', 'sfc-temp-c'].includes(layer));
  return { ...source, modelId: `parity-${model}`, id: `synthetic-parity-${model}`, grid, bounds, maxNativeZoom: 0, terrainSubdivisionFactor: 2,
    layers, frameHours: [1, 2], intervalHours: 1, intervalChange: undefined, mapEndHour: undefined,
    capabilities: { ...source.capabilities, daylightFrames: 'all-hours', maxVerticalLevels: 3 }, execution: { ...source.execution, shards: 2, workers: 0 } };
}

it('rejects invalid product shapes before opening a provider or writing coverage', async () => {
  const out = await temporaryRoot(), product = configured('gfs', regional, [10, 70, 12, 72]), mask = denseFixtureMask(product, regional);
  const open = vi.fn<ForecastProvider['open']>(async () => { throw new Error('Provider must not open'); });
  const provider = { id: 'fixture', provider: 'Synthetic', maxLevels: 3, open };
  const invalid = [
    { layers: [] }, { layers: ['precip-rate', 'precip-rate'] }, { layers: ['unknown'] }, { layers: ['toString'] },
    { frameHours: [] }, { frameHours: [1, 1] }, { frameHours: [2, 1] }, { frameHours: [1.5] }, { frameHours: [Infinity] }, { frameHours: [NaN] },
    { intervalHours: 0 }, { intervalHours: -1 }, { intervalHours: Infinity }, { intervalHours: NaN }, { intervalHours: 4 }
  ];
  for (const shape of invalid) {
    await expect(buildForecast({ out, product: { ...product, ...shape } as ProductDefinition, mask, provider })).rejects.toThrow(/Product requires|Product interval/);
  }
  expect(open).not.toHaveBeenCalled();
  expect(await readdir(out)).toEqual([]);
});

async function readManifest(path: string) {
  return manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8')));
}

it.each([
  { model: 'gfs', grid: wrapping, bounds: [-180, 70, 180, 72], lat: 71.5, lon: 179 },
  { model: 'icon-eu', grid: regional, bounds: [10, 70, 12, 72], lat: 71.5, lon: 10.5 },
  { model: 'rrfs', grid: gridSchema.parse(lambert.grid), bounds: [-180, -85, 180, 85], lat: 45, lon: -90 }
] satisfies { model: keyof typeof golden.models; grid: Grid; bounds: ProductDefinition['bounds']; lat: number; lon: number }[])('preserves $model scalar records, profiles and pixels from the baseline through sharded assembly', async ({ model, grid, bounds, lat, lon }) => {
  const serial = await temporaryRoot(), parallel = await temporaryRoot();
  const product = configured(model, grid, bounds), mask = denseFixtureMask(product, grid);
  const close = vi.fn(async () => {});
  const provider: ForecastProvider = { id: 'fixture', provider: 'Synthetic', maxLevels: 3, async open({ activeIndices }) {
    return { cycle: CYCLE, stats: { fixture: true }, close, async acquire(hour) {
      const input = normalizedFixtureFrame(grid, activeIndices, CYCLE, hour, 1);
      if (product.capabilities.verticalCoordinate === 'isobaric') return input;
      const { pressureLevelsHpa, ...frame } = input;
      const modelLevels: ModelLevelFrame = { ...frame, pressurePa: pressureLevelsHpa.map(p => new Float32Array(activeIndices.length).fill(p * 100)),
        missing: { ...frame.missing, pressure: pressureLevelsHpa.map(() => new Uint8Array(activeIndices.length)) } };
      return modelLevels;
    } };
  } };
  const options = { cycle: CYCLE, product, mask, provider };
  const onValidated = vi.fn();
  const serialPath = await buildForecast({ ...options, out: serial, wholeDomain: await syntheticWholeDomain(serial, product), onValidated });
  const plan = await createBuildPlan({ ...options, out: parallel, wholeDomain: await syntheticWholeDomain(parallel, product) });
  for (const [shard] of plan.groups.entries()) await buildShard({ ...options, out: parallel, plan, shard });
  const left = await readManifest(serialPath), right = await readManifest(await finalizeBuild({ ...options, out: parallel, plan }));
  const expected = golden.models[model];
  const hashes = (shards: readonly { key: string }[]) => Promise.all(shards.map(async shard => sha256(await readFile(join(serial, shard.key)))));
  expect({
    frames: left.frames,
    layers: left.layers,
    descriptorSha256: sha256(Buffer.from(JSON.stringify(left.descriptors))),
    storedMsl: left.tool.useStoredMslNoLift,
    surfaces: await Promise.all(left.surfaces.map(async surface => ({
      kind: surface.kind,
      coverage: surface.coverage.hash,
      samples: await hashes(surface.samples.shards),
      ...(surface.profiles ? { profiles: await hashes(surface.profiles.groups.flatMap(group => group.shards)) } : {})
    })))
  }, `Recorded at ${golden.baseline}`).toEqual({
    frames: expected.frames, layers: expected.layers, descriptorSha256: expected.descriptorSha256,
    storedMsl: expected.storedMsl, surfaces: expected.surfaces
  });
  expect(close).toHaveBeenCalledTimes(3);
  expect(right.frames).toEqual(left.frames);
  expect(right.layers).toEqual(left.layers);
  expect(right.descriptors).toEqual(left.descriptors);
  expect(right.method).toEqual(left.method);
  expect(() => assertValidatedBuild(serial, left, onValidated.mock.calls[0][0])).not.toThrow();
  expect(() => assertValidatedBuild(serial, left, { ...onValidated.mock.calls[0][0] })).toThrow('validation result');
  for (const source of left.surfaces) {
    const target = right.surfaces.find(surface => surface.kind === source.kind)!;
    expect(source.samples.format).toBe('cell-major-block-shards-v1');
    expect(target.samples.format).toBe('frame-group-block-shards-v1');
    expect(source.samples.shards.map(shard => shard.sha256)).toEqual(target.samples.shards.map(shard => shard.sha256));
  }
  const pixelHashes = async (root: string, manifest: ManifestV5) => Object.fromEntries(await Promise.all(manifest.artifacts.map(async artifact => [
    `${artifact.layer}/${artifact.frame}`, sha256(await tilePixels(root, artifact))
  ])));
  expect(await pixelHashes(serial, left), `Recorded at ${golden.baseline}`).toEqual(expected.pixels);
  expect(await pixelHashes(parallel, right)).toEqual(expected.pixels);

  const indices = nativeSparseMask(mask).coverage.blockIds, point = planSample(grid, lat, lon)!;
  const native = (manifest: ManifestV5) => manifest.surfaces.find(surface => surface.kind === 'native')!;
  for (let frame = 0; frame < left.frames.length; frame++) {
    const readProfile = async (root: string, manifest: ManifestV5) => {
      const profiles = native(manifest).profiles!;
      const group = profiles.groups.find(group => frame >= group.firstFrame && frame < group.firstFrame + group.frameCount)!;
      const layout = prepareShardedSamplePackLayout(grid, indices, group.frameCount, undefined, profiles.recordBytes);
      const block = layout.blockFor(point.contributors[0].index)!;
      const packed = planShardedPackedSample(layout, { ...point, contributors: [point.contributors[0]] }, [frame - group.firstFrame]);
      const bytes = await readFile(join(root, group.shards[block.shard].key));
      return readProfileRecord(bytes.subarray(packed.byteRange.offset, packed.byteRange.offset + packed.byteRange.length));
    };
    expect(await readProfile(parallel, right)).toEqual(await readProfile(serial, left));
  }
  if (product.layers.includes('precip-rate')) {
    const surface = native(left), channel = surface.layers.indexOf('precip-rate');
    const layout = prepareShardedSamplePackLayout(grid, indices, surface.samples.channelCount);
    const packed = planShardedPackedSample(layout, point, [channel]);
    const bytes = await readFile(join(serial, surface.samples.shards[packed.shard].key));
    const body = bytes.subarray(packed.byteRange.offset, packed.byteRange.offset + packed.byteRange.length);
    const sample = sampleCells(point, packedCellsFromRange(packed, body, channel), left.descriptors.layers['precip-rate'], false);
    expect(sample.value).toBeCloseTo(point.contributors.reduce((sum, cell) => sum + cell.weight * (1 + (cell.index % grid.width) * 0.25 + Math.floor(cell.index / grid.width) * 0.5), 0), 8);
  }
}, 60_000);
