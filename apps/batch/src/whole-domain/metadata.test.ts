import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { canonicalGridJson, createRecipeIdentity, createWholeDomainDescriptors, encodeBoundedJson, getProduct, layerSurface, manifestV5Schema, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, parseBoundedJson, PROFILE_PACK_FORMAT, renderedFrames, renderedLayers, SAMPLE_BLOCK_SIZE, sourceIntervalHours, type ForecastSurfaceV5, type ManifestV5 } from '@av/contracts';
import { prepareShardedSamplePackLayout, profileRecordBytes } from '@av/forecast';
import { describeSparseCoverage, loadCoverage } from '../coverage.js';
import { forecastFrame } from '../frame-build.js';
import { loadBundledFineCoverage, nativeSparseMask, wholeDomainPlan } from './coverage.js';

it.each(['gfs', 'icon-eu', 'rrfs'])('admits %s extended native profiles with its real coverage and bounded metadata', async model => {
  const configured = getProduct(model)!, hours = model === 'gfs'
    ? [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 120 }, (_, i) => 27 + i * 3)]
    : Array.from({ length: 48 }, (_, i) => i + 1);
  const product = { ...configured, frameHours: hours, mapEndHour: 24, ...(model === 'gfs' ? { intervalChange: { fromHour: 123, hours: 3 } } : {}) };
  const mask = await loadCoverage(product), plan = wholeDomainPlan(product)!, fine = await loadBundledFineCoverage(product, plan);
  const native = nativeSparseMask(mask), nativeDescription = describeSparseCoverage(native, product);
  const hash = 'f'.repeat(64), buildId = '20261105T000000Z-12345678-1234-4234-8234-123456789abc', prefix = `builds/${model}/${buildId}`;
  const count = Math.min(product.execution.shards, hours.length), groups = Array.from({ length: count }, (_, i) => hours.slice(Math.ceil(i * hours.length / count), Math.ceil((i + 1) * hours.length / count)));
  const surfaces: ForecastSurfaceV5[] = [];
  for (const kind of ['native', 'fine'] as const) {
    const grid = kind === 'native' ? plan.native : plan.fine, coverage = kind === 'native' ? native.coverage : fine.mask.coverage;
    const description = kind === 'native' ? nativeDescription : fine, layers = product.layers.filter(layer => layerSurface(layer) === kind);
    const shards: Extract<ForecastSurfaceV5['samples'], { format: 'frame-group-block-shards-v1' }>['shards'] = [], profileGroups: NonNullable<ForecastSurfaceV5['profiles']>['groups'] = [];
    let firstFrame = 0, storedCells = 0;
    for (const [group, selected] of groups.entries()) {
      const frameCount = kind === 'native' ? selected.length : selected.filter(hour => hour <= 24).length;
      if (!frameCount) continue;
      const layout = prepareShardedSamplePackLayout(grid, coverage.blockIds, frameCount * layers.length);
      storedCells = layout.storedCells;
      shards.push(...layout.shards.map((shard, blockShard) => ({ group, firstFrame, frameCount, blockShard, firstBlock: shard.firstBlock, blockCount: shard.blockCount,
        storedCells: shard.byteLength / (frameCount * layers.length * 5), bytes: shard.byteLength, key: `${prefix}/surfaces/${kind}/samples/g${group}-b${blockShard}.bin`, sha256: hash })));
      if (kind === 'native') {
        const width = profileRecordBytes(product.capabilities.maxVerticalLevels), layout = prepareShardedSamplePackLayout(grid, coverage.blockIds, frameCount, undefined, width);
        profileGroups.push({ firstFrame, frameCount, shards: layout.shards.map((shard, blockShard) => ({ firstBlock: shard.firstBlock, blockCount: shard.blockCount,
          storedCells: shard.byteLength / (frameCount * width), bytes: shard.byteLength, key: `${prefix}/surfaces/${kind}/profiles/g${group}-b${blockShard}.bin`, sha256: hash })) });
      }
      firstFrame += frameCount;
    }
    const gridHash = createHash('sha256').update(canonicalGridJson(grid)).digest('hex');
    surfaces.push({ id: kind, kind, grid, gridHash,
      coverage: { id: product.coverageId, hash: description.hash, maskKey: `coverage/${description.hash}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash }, layers,
      samples: { format: 'frame-group-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer', channelCount: firstFrame * layers.length,
        coverageHash: description.hash, blockCount: coverage.blockIds.length, storedCells, shards },
      ...(kind === 'native' ? { profiles: { format: PROFILE_PACK_FORMAT, blockSize: SAMPLE_BLOCK_SIZE, levelCount: product.capabilities.maxVerticalLevels,
        recordBytes: profileRecordBytes(product.capabilities.maxVerticalLevels), coverageHash: description.hash, blockCount: coverage.blockIds.length, storedCells, groups: profileGroups } }
        : { terrain: { dataId: hash, key: `terrain/prepared/${hash}/manifest.json`, sha256: hash, verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash: description.hash, layoutVersion: 1 } }) });
  }
  const cycle = '2026-11-05T00:00:00.000Z', frames = hours.map(hour => forecastFrame(cycle, hour, sourceIntervalHours(product, hour))), descriptors = createWholeDomainDescriptors(product);
  const manifest: ManifestV5 = { version: 5, mapFrameCount: 24, descriptors, recipe: createRecipeIdentity(product, hash), model, buildId, cycle, createdAt: cycle, expiresAt: '2026-11-12T00:00:00.000Z',
    method: { id: [...new Set(product.layers.map(layer => descriptors.layers[layer]!.methodId))].join('+'), hash }, frames, layers: [...product.layers], surfaces,
    artifacts: frames.slice(0, 24).flatMap(frame => renderedLayers(product.layers).map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: hash }))),
    source: { provider: model, provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash }, tool: {}, palettes: descriptors.palettes.map(palette => palette.id), metrics: {} };
  const bytes = encodeBoundedJson(manifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS), decoded = manifestV5Schema.parse(parseBoundedJson(bytes, MAX_MANIFEST_JSON_TOKENS));
  expect(bytes.length).toBeLessThan(256 * 1024);
  expect(decoded.frames).toHaveLength(model === 'gfs' ? 144 : 48);
  expect(renderedFrames(decoded)).toHaveLength(24);
  expect(decoded.artifacts).toHaveLength(72);
  expect(decoded.surfaces[0]!.samples.channelCount).toBe(hours.length * 18);
  expect(decoded.surfaces[1]!.samples.channelCount).toBe(48);
  if (model === 'rrfs') {
    expect(decoded.surfaces[0]!.profiles!.groups.flatMap(group => group.shards)).toHaveLength(432);
    expect(() => parseBoundedJson(bytes)).toThrow('object budget');
  }
});
