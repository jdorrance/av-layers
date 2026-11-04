import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import {
  CELL_BYTES,
  GFS_PRODUCT,
  SAMPLE_BLOCK_SIZE,
  canonicalGridJson,
  createWholeDomainDescriptors,
  createRecipeIdentity,
  gridSchema,
  manifestV5Schema,
  planWholeDomainGrid,
  sparseCoverageFromDense,
  type ForecastSurfaceV5,
  type Grid,
  type LayerId,
  type ManifestV5,
  type ProductDefinition,
  type SparseCoverageMask
} from '@av/contracts';
import { prepareShardedSamplePackLayout, type ShardedSamplePackLayout } from '@av/forecast';
import { describeSparseCoverage } from '../../batch/src/coverage';
import { createApp } from '../src/index';

export const NOW = Date.parse('2026-11-01T00:00:00Z');
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const stream = (bytes: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });

export const NATIVE_GRID: Grid = gridSchema.parse({
  kind: 'regular-latlon', width: 32, height: 18, lon0: -180, lat0: 17, dx: 11.25, dy: -1, wrapLongitude: true, earthRadiusM: 6371229
});
export const FINE_GRID: Grid = planWholeDomainGrid(NATIVE_GRID as Extract<Grid, { kind: 'regular-latlon' }>, 2).fine;
const BOUNDS: [number, number, number, number] = [-180, -2, 180, 18];
const FINE_LAYERS: LayerId[] = ['usable-lift-msl', 'usable-lift-agl'];
const NATIVE_LAYERS: LayerId[] = ['precip-rate'];
const PRODUCT: ProductDefinition = { ...GFS_PRODUCT, grid: NATIVE_GRID, coverageId: 'native-mask', coverageDescription: 'Synthetic native surface', bounds: BOUNDS, maxNativeZoom: 1, supportHaloCells: 1, terrainSubdivisionFactor: 2 };

export const finePoint = (x: number, y: number) => ({ lat: 17 - 0.5 * y, lon: -180 + 5.625 * x });
export const nativePoint = (x: number, y: number) => ({ lat: 17 - y, lon: -180 + 11.25 * x });
export const commonPoint = { lat: 9, lon: -180 };

function denseMask(grid: Grid, active: (x: number, y: number) => boolean): SparseCoverageMask {
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
    grid, bounds: BOUNDS, maxZoom: 1, tiles: Uint8Array.of(0),
    coverage: sparseCoverageFromDense({ width: grid.width, height: grid.height, wrapLongitude: grid.wrapLongitude, gridHash: hash(new TextEncoder().encode(canonicalGridJson(grid))), output, halo })
  };
}

interface SurfaceFixture { surface: ForecastSurfaceV5; layout: ShardedSamplePackLayout; bytes: Uint8Array; objects: Map<string, Uint8Array>; shardSha: Map<string, string> }

function buildSurface(grid: Grid, id: string, kind: 'native' | 'fine', layers: LayerId[], active: (x: number, y: number) => boolean, value: (channel: number, x: number, y: number) => { value: number; flags: number }, prefix: string): SurfaceFixture {
  const mask = denseMask(grid, active);
  const description = describeSparseCoverage(mask, PRODUCT);
  const coveragePrefix = `coverage/${description.hash}`;
  const channelCount = 2 * layers.length;
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
    coverage: { id: description.descriptor.id, hash: description.hash, maskKey: `${coveragePrefix}/manifest.json`, maxZoom: 1, gridHash },
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
  return { surface, layout, bytes, objects, shardSha: new Map([[shardKey, shardSha]]) };
}

export function createV5Fixture() {
  const buildId = 'v5-fixture-1', prefix = `builds/gfs/${buildId}`;
  const cycle = new Date(NOW).toISOString(), expiresAt = new Date(NOW + 86_400_000).toISOString();
  const frames = [1, 2].map(hour => ({ id: `h${String(hour).padStart(3, '0')}`, validTime: new Date(NOW + hour * 3_600_000).toISOString(), intervalStart: new Date(NOW + (hour - 1) * 3_600_000).toISOString(), intervalEnd: new Date(NOW + hour * 3_600_000).toISOString() }));
  const fine = buildSurface(FINE_GRID, 'fine', 'fine', FINE_LAYERS, (_x, y) => y >= 16 && y <= 19, (channel, x, y) => {
    const layer = channel % 2, frame = Math.floor(channel / 2);
    if (layer === 0) return x === 4 && y === 17 ? { value: 0, flags: 1 } : { value: 310.25 + frame * 10 + (y === 17 ? 10 : 0), flags: 4 };
    return x === 5 && y === 17 ? { value: 0, flags: 2 } : { value: 610.25 + frame * 10, flags: 8 };
  }, prefix);
  const native = buildSurface(NATIVE_GRID, 'native', 'native', NATIVE_LAYERS, (_x, y) => y >= 8 && y <= 10, channel => ({ value: 7 + channel, flags: 0 }), prefix);
  const layers: LayerId[] = ['usable-lift-msl', 'usable-lift-agl', 'precip-rate'];
  const provenance = json({ version: 1, model: 'gfs', buildId, cycle, frames: [] });
  const descriptors = createWholeDomainDescriptors(PRODUCT);
  const manifest: ManifestV5 = manifestV5Schema.parse({
    version: 5, model: 'gfs', buildId, cycle, createdAt: cycle, expiresAt,
    descriptors, recipe: createRecipeIdentity(PRODUCT, 'a'.repeat(64)),
    method: { id: [...new Set(PRODUCT.layers.map(layer => descriptors.layers[layer].methodId))].join('+'), hash: 'a'.repeat(64) },
    frames, layers,
    artifacts: frames.flatMap(frame => layers.map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'b'.repeat(64) }))),
    surfaces: [fine.surface, native.surface],
    source: { provider: 'NOAA', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: hash(provenance) },
    tool: {}, palettes: ['lift', 'rain'], metrics: {}
  });
  const objects = new Map<string, Uint8Array>([
    [`${prefix}/manifest.json`, json(manifest)], [`${prefix}/provenance.json`, provenance],
    ...fine.objects, ...native.objects,
    [`catalog/gfs/latest.json`, json({ version: 1, model: 'gfs', latestBuildId: buildId, retained: [{ buildId, manifestKey: `${prefix}/manifest.json`, cycle, expiresAt }] })]
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
  const app = createApp({ products: { gfs: PRODUCT } });
  const request = (path: string) => app.fetch(new Request(`https://api.test${path}`, { headers: { 'cf-connecting-ip': '192.0.2.1' } }), { BUCKET: bucket, SAMPLE_RATE_LIMITER: { limit: async () => ({ success: true }) } }, { waitUntil() {} });
  const sample = (lat: number, lon: number, query = '') => request(`/v1/models/gfs/runs/${buildId}/sample?lat=${lat}&lon=${lon}${query}`);
  return { manifest, objects, shardSha, get, bucket, app, request, sample, fine, native, buildId };
}
