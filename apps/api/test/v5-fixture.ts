import { INDEXED_PRODUCT } from '../../../tests/model-fixtures';
import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  CELL_BYTES,
  SAMPLE_BLOCK_SIZE,
  canonicalGridJson,
  createWholeDomainDescriptors,
  createRecipeIdentity,
  gridSchema,
  manifestV5Schema,
  planWholeDomainGrid,
  renderedLayers,
  layerSurface,
  sparseCoverageLookup,
  sparseCoverageFromDense,
  type ForecastSurfaceV5,
  type Grid,
  type LayerId,
  type ManifestV5,
  type ProductDefinition,
  type SparseCoverageMask
} from '@av/contracts';
import { prepareShardedSamplePackLayout, profileRecordBytes, writeProfileRecord, type NativeProfileInput, type ShardedSamplePackLayout } from '@av/forecast';
import { describeSparseCoverage } from '../../batch/src/coverage';
import { createApp } from '../src/index';

export const NOW = Date.parse('2026-11-01T00:00:00Z');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

const NATIVE_GRID: Grid = gridSchema.parse({
  kind: 'regular-latlon', width: 32, height: 18, lon0: -180, lat0: 17, dx: 11.25, dy: -1, wrapLongitude: true, earthRadiusM: 6371229
});
const BOUNDS: [number, number, number, number] = [-180, -2, 180, 18];
const FINE_LAYERS: LayerId[] = ['usable-lift-msl', 'usable-lift-agl'];
const NATIVE_LAYERS: LayerId[] = ['precip-rate'];

export const finePoint = (x: number, y: number) => ({ lat: 17 - 0.5 * y, lon: -180 + 5.625 * x });
export const nativePoint = (x: number, y: number) => ({ lat: 17 - y, lon: -180 + 11.25 * x });
export const commonPoint = { lat: 9, lon: -180 };

function denseMask(grid: Grid, maxZoom: number, active: (x: number, y: number) => boolean, bounds: ProductDefinition['bounds']): SparseCoverageMask {
  const output = new Uint8Array(Math.ceil(grid.width * grid.height / 8));
  const halo = new Uint8Array(output.length);
  const set = (bits: Uint8Array, x: number, y: number) => {
    const index = y * grid.width + x;
    bits[index >> 3] |= 1 << (index & 7);
  };
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) if (active(x, y)) set(output, x, y);
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    if (!active(x, y)) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = grid.wrapLongitude ? ((x + dx) % grid.width + grid.width) % grid.width : x + dx, ny = y + dy;
      if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height && !active(nx, ny)) set(halo, nx, ny);
    }
  }
  return {
    grid, bounds, maxZoom, tiles: new Uint8Array(Math.ceil(((4 ** (maxZoom + 1) - 1) / 3) / 8)),
    coverage: sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: grid.wrapLongitude, gridHash: hash(new TextEncoder().encode(canonicalGridJson(grid))), output, halo })
  };
}

interface SurfaceFixture { surface: ForecastSurfaceV5; mask: SparseCoverageMask; layout: ShardedSamplePackLayout; bytes: Uint8Array; objects: Map<string, Uint8Array>; shardSha: Map<string, string> }

function buildSurface(product: ProductDefinition, grid: Grid, id: string, kind: 'native' | 'fine', layers: LayerId[], frameCount: number, active: (x: number, y: number) => boolean, value: (channel: number, x: number, y: number) => { value: number; flags: number }, prefix: string, masterZoom: number, coveredTile: boolean): SurfaceFixture {
  const mask = denseMask(grid, masterZoom, active, product.bounds);
  if (coveredTile) mask.tiles[0] = 1;
  const description = describeSparseCoverage(mask, product);
  const coveragePrefix = `coverage/${description.hash}`;
  const channelCount = frameCount * layers.length;
  const layout = prepareShardedSamplePackLayout(grid, mask.coverage.blockIds, channelCount);
  if (layout.shards.length !== 1) throw new Error('Compact fixture expects one shard');
  const bytes = new Uint8Array(layout.byteLength), view = new DataView(bytes.buffer);
  for (let i = 0; i < layout.blockCount; i++) {
    const block = layout.block(i);
    for (let y = 0; y < block.height; y++) for (let x = 0; x < block.width; x++) {
      const gx = grid.wrapLongitude ? (block.column + x) % grid.width : block.column + x, gy = block.row + y;
      for (let channel = 0; channel < channelCount; channel++) {
        const cell = value(channel, gx, gy);
        const offset = block.byteOffset + ((y * block.width + x) * channelCount + channel) * CELL_BYTES;
        view.setFloat32(offset, cell.value, true);
        view.setUint8(offset + 4, cell.flags);
      }
    }
  }
  const shardKey = `${prefix}/surfaces/${id}/samples/0.bin`, shardSha = hash(bytes);
  const gridHash = hash(new TextEncoder().encode(canonicalGridJson(grid)));
  const surface: ForecastSurfaceV5 = {
    id, kind, grid, gridHash,
    coverage: { id: description.descriptor.id, hash: description.hash, maskKey: `${coveragePrefix}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash },
    layers,
    samples: {
      format: 'cell-major-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer', channelCount,
      coverageHash: description.hash, blockCount: layout.blockCount, storedCells: layout.storedCells,
      shards: [{ firstBlock: 0, blockCount: layout.blockCount, storedCells: layout.storedCells, bytes: bytes.length, key: shardKey, sha256: shardSha }]
    },
    ...(kind === 'fine' ? { terrain: { dataId: 'd'.repeat(64), key: `terrain/prepared/${'d'.repeat(64)}/manifest.json`, sha256: 'd'.repeat(64), verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash: description.hash, layoutVersion: 1 as const } } : {})
  };
  const objects = new Map<string, Uint8Array>([
    [`${coveragePrefix}/manifest.json`, description.bytes],
    [`${coveragePrefix}/sparse.bin`, description.sparseBytes],
    [`${coveragePrefix}/tiles.bin`, mask.tiles],
    [shardKey, bytes]
  ]);
  return { surface, mask, layout, bytes, objects, shardSha: new Map([[shardKey, shardSha]]) };
}

interface FixtureOptions {
  product?: ProductDefinition; grid?: Grid; bounds?: ProductDefinition['bounds']; maxZoom?: number; renderZoom?: number; buildId?: string; frameHours?: readonly number[];
  mapFrameCount?: number;
  framePrefix?: 'f' | 'h';
  cycleTime?: number;
  coveredTile?: boolean;
  nativeLayers?: readonly LayerId[];
  nativeValue?: (layer: LayerId, frame: number, x: number, y: number) => number | null;
}

export function createV5Fixture({ product: base = INDEXED_PRODUCT, grid = NATIVE_GRID, bounds = BOUNDS, maxZoom = 1, renderZoom = maxZoom, buildId = '20261101T000000Z-00000000-0000-0000-0000-000000000001', frameHours = [1, 2], mapFrameCount, framePrefix = 'h', cycleTime = NOW, coveredTile = false, nativeLayers, nativeValue }: FixtureOptions = {}) {
  const configuredNative = base.layers.filter(layer => layerSurface(layer) === 'native');
  const nativeChannels = nativeLayers ?? (configuredNative.length ? configuredNative : NATIVE_LAYERS);
  const product: ProductDefinition = { ...base, ...(nativeLayers ? { layers: [...FINE_LAYERS, ...nativeLayers] } : {}), grid, coverageId: 'native-mask', coverageDescription: 'Synthetic native surface', bounds, maxNativeZoom: renderZoom, supportHaloCells: 1, terrainSubdivisionFactor: 2 };
  const model = product.modelId, prefix = `builds/${model}/${buildId}`;
  const cycle = new Date(cycleTime).toISOString(), expiresAt = new Date(cycleTime + 86_400_000).toISOString();
  const frames = frameHours.map(hour => ({ id: `${framePrefix}${String(hour).padStart(3, '0')}`, validTime: new Date(cycleTime + hour * 3_600_000).toISOString(), intervalStart: new Date(cycleTime + (hour - 1) * 3_600_000).toISOString(), intervalEnd: new Date(cycleTime + hour * 3_600_000).toISOString() }));
  const fine = buildSurface(product, planWholeDomainGrid(grid, 2).fine, 'fine', 'fine', FINE_LAYERS, mapFrameCount ?? frames.length, (_x, y) => y >= 16 && y <= 19, (channel, x, y) => {
    const layer = channel % 2, frame = Math.floor(channel / 2);
    if (layer === 0) return x === 4 && y === 17 ? { value: 0, flags: 1 } : { value: 310.25 + frame * 10 + (y === 17 ? 10 : 0), flags: 4 };
    return x === 5 && y === 17 ? { value: 0, flags: 2 } : { value: 610.25 + frame * 10, flags: 8 };
  }, prefix, maxZoom, coveredTile);
  const native = buildSurface(product, grid, 'native', 'native', [...nativeChannels], frames.length, (_x, y) => y >= 8 && y <= 10, (channel, x, y) => {
    const value = nativeValue ? nativeValue(nativeChannels[channel % nativeChannels.length]!, Math.floor(channel / nativeChannels.length), x, y) : 7 + channel;
    return { value: value ?? NaN, flags: value === null ? 2 : 0 };
  }, prefix, maxZoom, coveredTile);
  const layers = [...product.layers], surfaces = nativeLayers || configuredNative.length ? [fine.surface, native.surface] : [fine.surface];
  const provenance = json({ version: 1, model, buildId, cycle, frames: [] });
  const descriptors = createWholeDomainDescriptors(product);
  const manifest: ManifestV5 = manifestV5Schema.parse({
    version: 5, model, buildId, cycle, createdAt: cycle, expiresAt,
    descriptors, recipe: createRecipeIdentity(product, 'a'.repeat(64)),
    method: { id: [...new Set(product.layers.map(layer => descriptors.layers[layer].methodId))].join('+'), hash: 'a'.repeat(64) },
    frames, layers, ...(mapFrameCount === undefined ? {} : { mapFrameCount }),
    artifacts: frames.slice(0, mapFrameCount ?? frames.length).flatMap(frame => renderedLayers(layers).map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'b'.repeat(64) }))),
    surfaces,
    source: { provider: 'Fixture', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash(provenance) },
    tool: {}, palettes: ['lift', 'rain'], metrics: {}
  });
  const objects = new Map<string, Uint8Array>([
    [`${prefix}/manifest.json`, json(manifest)], [`${prefix}/provenance.json`, provenance],
    ...fine.objects, ...native.objects,
    [`catalog/${model}/latest.json`, json({ version: 1, model, latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle, expiresAt }] })]
  ]);
  const shardSha = new Map([...fine.shardSha, ...native.shardSha]);
  const get = vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }) => {
    const bytes = objects.get(key);
    if (!bytes) return null;
    if (!options?.range) return { size: bytes.length, body: stream(bytes) };
    const { offset, length } = options.range;
    if (offset < 0 || length < 0 || offset + length > bytes.length) return null;
    return { size: bytes.length, range: options.range, customMetadata: shardSha.has(key) ? { sha256: shardSha.get(key)! } : undefined, body: stream(bytes.slice(offset, offset + length)) };
  });
  const bucket = { get } as unknown as R2Bucket;
  const app = createApp({ products: { [model]: product } });
  const request = (path: string) => app.fetch(new Request(`https://api.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  const sample = (lat: number, lon: number, query = '') => request(`/v1/models/${model}/runs/${buildId}/sample?lat=${lat}&lon=${lon}${query}`);
  return { product, manifest, objects, shardSha, get, bucket, app, request, sample, fine, native, buildId };
}

/** Pack genuine profile records with the same block and frame-group layout as publication. */
export function attachNativeProfiles(fixture: ReturnType<typeof createV5Fixture>, options: {
  levels?: number; groupSize?: number;
  profile?: (frame: number, x: number, y: number) => NativeProfileInput;
} = {}) {
  const surface = fixture.manifest.surfaces.find(surface => surface.kind === 'native');
  if (!surface) throw new Error('Profile fixture requires a native surface');
  const levels = options.levels ?? 2, recordBytes = profileRecordBytes(levels), groupSize = options.groupSize ?? fixture.manifest.frames.length;
  const blockIds = fixture.native.mask.coverage.blockIds;
  const groups: NonNullable<ForecastSurfaceV5['profiles']>['groups'] = [];
  const prefix = `builds/${fixture.manifest.model}/${fixture.buildId}/surfaces/${surface.id}/profiles`;
  for (let firstFrame = 0, group = 0; firstFrame < fixture.manifest.frames.length; firstFrame += groupSize, group++) {
    const frameCount = Math.min(groupSize, fixture.manifest.frames.length - firstFrame);
    const layout = prepareShardedSamplePackLayout(surface.grid, blockIds, frameCount, undefined, recordBytes);
    const data = layout.shards.map(shard => new Uint8Array(shard.byteLength));
    for (let ordinal = 0; ordinal < layout.blockCount; ordinal++) {
      const block = layout.block(ordinal), bytes = data[block.shard]!;
      for (let row = 0; row < block.height; row++) for (let column = 0; column < block.width; column++) {
        const x = (block.column + column) % surface.grid.width, y = block.row + row;
        const covered = sparseCoverageLookup(fixture.native.mask.coverage, x, y);
        for (let frame = 0; frame < frameCount; frame++) {
          const offset = block.byteOffset + ((row * block.width + column) * frameCount + frame) * recordBytes;
          const profile = covered?.output || covered?.halo ? options.profile?.(firstFrame + frame, x, y) ?? {
            modelTerrainM: 100 + x, surfacePressureHpa: 987.6, status: 'valid' as const,
            levels: Array.from({ length: levels }, (_, index) => ({ pressureHpa: 900 - index * 25, heightM: 600 + index * 500,
              temperatureC: 15 - index * 3 + firstFrame + frame, dewPointC: 10 - index * 3,
              uWindMps: 2 + x, vWindMps: -3, omegaPaS: 0.1 }))
          } : { modelTerrainM: null, status: 'outside-domain' as const, levels: [] };
          writeProfileRecord(bytes.subarray(offset, offset + recordBytes), profile);
        }
      }
    }
    const shards: NonNullable<ForecastSurfaceV5['profiles']>['groups'][number]['shards'] = [];
    for (const [blockShard, part] of layout.shards.entries()) {
      const bytes = data[blockShard]!, key = `${prefix}/g${group}-b${blockShard}.bin`, sha256 = hash(bytes);
      fixture.objects.set(key, bytes); fixture.shardSha.set(key, sha256);
      shards.push({ firstBlock: part.firstBlock, blockCount: part.blockCount,
        storedCells: part.byteLength / (frameCount * recordBytes), bytes: bytes.length, key, sha256 });
    }
    groups.push({ firstFrame, frameCount, shards });
  }
  surface.profiles = { format: 'native-column-profile-v1', blockSize: SAMPLE_BLOCK_SIZE, levelCount: levels, recordBytes,
    coverageHash: surface.coverage.hash, blockCount: surface.samples.blockCount, storedCells: surface.samples.storedCells, groups };
  manifestV5Schema.parse(fixture.manifest);
  fixture.objects.set(`builds/${fixture.manifest.model}/${fixture.buildId}/manifest.json`, json(fixture.manifest));
  return fixture;
}

export function createGroupedV5Fixture({ groups, ...options }: Omit<FixtureOptions, 'frameHours'> & { groups: readonly (readonly number[])[] }) {
  const fixture = createV5Fixture({ ...options, frameHours: groups.flat() });
  const { manifest, objects, shardSha } = fixture, prefix = `builds/${manifest.model}/${manifest.buildId}`;
  for (const surface of manifest.surfaces) {
    const source = surface.kind === 'fine' ? fixture.fine : fixture.native;
    const blockIds = Uint32Array.from({ length: source.layout.blockCount }, (_, i) => source.layout.block(i).slot);
    const shards: Extract<typeof surface.samples, { format: 'frame-group-block-shards-v1' }>['shards'] = [];
    let firstFrame = 0;
    const count = surface.kind === 'fine' ? manifest.mapFrameCount ?? manifest.frames.length : manifest.frames.length;
    for (const [group, hours] of groups.entries()) {
      if (firstFrame >= count) break;
      const frameCount = Math.min(hours.length, count - firstFrame), channels = frameCount * surface.layers.length;
      const layout = prepareShardedSamplePackLayout(surface.grid, blockIds, channels), data = new Uint8Array(layout.byteLength);
      for (let block = 0; block < layout.blockCount; block++) {
        const target = layout.block(block), original = source.layout.block(block);
        for (let cell = 0; cell < target.width * target.height; cell++) {
          const from = original.byteOffset + (cell * source.layout.channelCount + firstFrame * surface.layers.length) * CELL_BYTES;
          data.set(source.bytes.subarray(from, from + channels * CELL_BYTES), target.byteOffset + cell * channels * CELL_BYTES);
        }
      }
      const key = `${prefix}/surfaces/${surface.id}/samples/g${group}-b0.bin`, sha256 = hash(data);
      objects.set(key, data); shardSha.set(key, sha256);
      shards.push({ group, firstFrame, frameCount, blockShard: 0, firstBlock: 0, blockCount: layout.blockCount, storedCells: layout.storedCells, bytes: data.length, key, sha256 });
      firstFrame += frameCount;
    }
    surface.samples = { ...surface.samples, format: 'frame-group-block-shards-v1', shards };
  }
  objects.set(`${prefix}/manifest.json`, json(manifest));
  return fixture;
}
