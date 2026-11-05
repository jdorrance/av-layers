import { MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_SPARSE_COVERAGE_BYTES, assertCoverageBinding, assertSampleLayoutBindingV5, assertSparseCoverageHalo, canonicalGridJson, coverageDescriptorSchema, sparseCoverageDescriptorSchema, coveragePrefix, decodeSparseCoverage, sameGrid, type CoverageDescriptor, type CoverageMask, type ForecastGrid, type ForecastSurfaceV5, type SparseCoverageDescriptor, type SparseCoverageMask } from '@av/contracts';
import { SAMPLE_SHARD_TARGET_BYTES, prepareSamplePackLayout, prepareShardedSamplePackLayout, type SamplePackLayout, type ShardedSamplePackLayout } from '@av/forecast';
import { countRead, countCacheHit, ByteCache, MaterializedReads, readObjectBytes, parseBoundedJson, reserveAllocation, estimateJsonBytes, type WaitContext } from './resources';

export class CoverageError extends Error {}
export interface ResolvedCoverage { descriptor: CoverageDescriptor; mask: CoverageMask; layout: SamplePackLayout }
export interface FrameGroupShard {
  group: number; firstFrame: number; frameCount: number; blockShard: number;
  firstBlock: number; blockCount: number; storedCells: number; bytes: number; key: string; sha256: string;
}
export interface FrameGroup {
  group: number; firstFrame: number; frameCount: number; channelCount: number; shards: readonly FrameGroupShard[];
}
export interface ResolvedSparseCoverage {
  descriptor: SparseCoverageDescriptor;
  mask: SparseCoverageMask;
  layout: ShardedSamplePackLayout;
  layouts: ReadonlyMap<number, ShardedSamplePackLayout>;
  groups: readonly FrameGroup[] | null;
}
interface SparseTiles { descriptor: SparseCoverageDescriptor; tiles: Uint8Array }
const caches = new WeakMap<R2Bucket, ByteCache<string, ResolvedCoverage | ResolvedSparseCoverage | SparseTiles>>();
const flights = new WeakMap<R2Bucket, MaterializedReads<ResolvedCoverage | ResolvedSparseCoverage | SparseTiles>>();
const tileFlights = new WeakMap<R2Bucket, MaterializedReads<SparseTiles>>();
const COVERAGE_CACHE_BYTES = 24 * 1024 * 1024;
const MAX_API_SPARSE_BYTES = MAX_SPARSE_COVERAGE_BYTES;
interface SparseLease { refs: number; loading: boolean; bytes: number; release?: () => void; value?: ResolvedSparseCoverage }
const sparseLeases = new WeakMap<R2Bucket, Map<string, SparseLease>>();
export function coverageMemory(bucket: R2Bucket): { cachedBytes: number; leasedBytes: number; leaseRefs: number } {
  const leases = [...(sparseLeases.get(bucket)?.values() ?? [])];
  return { cachedBytes: caches.get(bucket)?.bytes ?? 0, leasedBytes: leases.reduce((sum, lease) => sum + lease.bytes, 0), leaseRefs: leases.reduce((sum, lease) => sum + lease.refs, 0) };
}
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Only hash-verified materialized bytes cross request boundaries; R2 bodies never do. */
export async function resolveCoverage(bucket: R2Bucket, manifest: ForecastGrid, ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<ResolvedCoverage> {
  waiterSignal?.throwIfAborted();
  const { hash, maskKey } = manifest.coverage;
  const prefix = coveragePrefix(hash);
  if (maskKey !== `${prefix}/manifest.json`) throw new CoverageError('Invalid coverage descriptor key');
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(16, COVERAGE_CACHE_BYTES); caches.set(bucket, cache); }
  let resolved = cache.get(hash) as ResolvedCoverage | undefined;
  if (resolved) countCacheHit(ctx);
  if (!resolved) {
    let reads = flights.get(bucket);
    if (!reads) { reads = new MaterializedReads(2); flights.set(bucket, reads); }
    resolved = await reads.run(hash, async signal => {
      countRead(ctx);
      const object = await bucket.get(maskKey);
      if (!object) throw new CoverageError('Coverage descriptor missing');
      const bytes = await readObjectBytes(object, MAX_COVERAGE_DESCRIPTOR_BYTES, false, ctx, signal);
      if (await sha256(bytes) !== hash) throw new CoverageError('Coverage descriptor hash mismatch');
      let descriptor;
      try { descriptor = coverageDescriptorSchema.parse(parseBoundedJson(bytes)); }
      catch { throw new CoverageError('Invalid coverage descriptor'); }
      const reads = await Promise.allSettled((['output', 'halo', 'tiles'] as const).map(async name => {
        const file = descriptor.files[name];
        countRead(ctx);
        const blob = await bucket.get(`${prefix}/${name}.bin`);
        if (!blob) throw new CoverageError(`Coverage ${name} missing`);
        const data = await readObjectBytes(blob, file.bytes, false, ctx, signal);
        if (data.length !== file.bytes || await sha256(data) !== file.sha256) throw new CoverageError(`Coverage ${name} hash mismatch`);
        return data;
      }));
      // Keep the owner admitted until every R2 operation settles, even if one
      // sibling failed. Native R2 get() does not accept an abort signal.
      const values = reads.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
      });
      const [output, halo, tiles] = values;
      const mask: CoverageMask = { grid: descriptor.grid, output, halo, tiles, maxZoom: descriptor.maxZoom, bounds: descriptor.bounds };
      const layout = prepareSamplePackLayout(mask.grid, output, halo);
      const result = { descriptor, mask, layout };
      // Bitsets plus conservative accounting for layout indexes and parsed descriptor.
      const retainedBytes = output.length + halo.length + tiles.length + Math.ceil(mask.grid.width / 16) * Math.ceil(mask.grid.height / 16) * 32 + bytes.length * 4;
      cache!.set(hash, result, retainedBytes, Date.now() + 3_600_000);
      return result;
    }, ctx, waiterSignal) as ResolvedCoverage;
  }
  try { assertCoverageBinding(resolved.descriptor, manifest); }
  catch { throw new CoverageError('Coverage geometry or sample layout disagrees with publication'); }
  if (resolved.layout.storedCells !== manifest.samples.storedCells) {
    throw new CoverageError('Coverage geometry or sample layout disagrees with publication');
  }
  return resolved;
}

export async function resolveSparseTiles(bucket: R2Bucket, surface: ForecastSurfaceV5, bounds?: readonly number[], ctx?: WaitContext): Promise<SparseTiles> {
  const { hash, maskKey } = surface.coverage, prefix = coveragePrefix(hash), cacheKey = `${hash}/tiles`;
  if (maskKey !== `${prefix}/manifest.json`) throw new CoverageError('Invalid coverage descriptor key');
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(16, COVERAGE_CACHE_BYTES); caches.set(bucket, cache); }
  let result = cache.get(cacheKey) as SparseTiles | undefined;
  if (result) countCacheHit(ctx);
  if (!result) {
    let reads = tileFlights.get(bucket);
    if (!reads) { reads = new MaterializedReads(2); tileFlights.set(bucket, reads); }
    result = await reads.run(cacheKey, async signal => {
      countRead(ctx);
      const object = await bucket.get(maskKey);
      if (!object) throw new CoverageError('Coverage descriptor missing');
      const bytes = await readObjectBytes(object, MAX_COVERAGE_DESCRIPTOR_BYTES, false, ctx, signal);
      if (await sha256(bytes) !== hash) throw new CoverageError('Coverage descriptor hash mismatch');
      let descriptor: SparseCoverageDescriptor;
      try { descriptor = sparseCoverageDescriptorSchema.parse(parseBoundedJson(bytes)); }
      catch { throw new CoverageError('Invalid sparse coverage descriptor'); }
      if (await sha256(new TextEncoder().encode(canonicalGridJson(descriptor.grid))) !== descriptor.gridHash) throw new CoverageError('Sparse coverage grid hash mismatch');
      countRead(ctx);
      const objectTiles = await bucket.get(`${prefix}/tiles.bin`);
      if (!objectTiles) throw new CoverageError('Coverage tiles missing');
      const tiles = await readObjectBytes(objectTiles, descriptor.files.tiles.bytes, false, ctx, signal);
      if (tiles.length !== descriptor.files.tiles.bytes || await sha256(tiles) !== descriptor.files.tiles.sha256) throw new CoverageError('Coverage tiles hash mismatch');
      const value = { descriptor, tiles };
      cache!.set(cacheKey, value, tiles.byteLength + bytes.length * 4, Date.now() + 3_600_000);
      return value;
    }, ctx) as SparseTiles;
  }
  const descriptor = result.descriptor;
  if (descriptor.id !== surface.coverage.id || descriptor.maxZoom < surface.coverage.maxZoom || descriptor.gridHash !== surface.gridHash
      || descriptor.gridHash !== surface.coverage.gridHash || !sameGrid(descriptor.grid, surface.grid)
      || (bounds && JSON.stringify(descriptor.bounds) !== JSON.stringify(bounds))) throw new CoverageError('Coverage geometry disagrees with publication');
  return result;
}

function frameGroups(surface: ForecastSurfaceV5): FrameGroup[] | null {
  if (surface.samples.format !== 'frame-group-block-shards-v1') return null;
  const shards = surface.samples.shards;
  const grouped = new Map<number, { firstFrame: number; frameCount: number; channelCount: number; shards: FrameGroupShard[] }>();
  for (const shard of shards) {
    const channelCount = shard.frameCount * surface.layers.length;
    const group = grouped.get(shard.group);
    if (!group) grouped.set(shard.group, { firstFrame: shard.firstFrame, frameCount: shard.frameCount, channelCount, shards: [shard] });
    else {
      if (group.firstFrame !== shard.firstFrame || group.frameCount !== shard.frameCount) throw new CoverageError('Inconsistent frame group shard');
      group.shards.push(shard);
    }
  }
  return [...grouped.entries()].sort(([left], [right]) => left - right)
    .map(([group, value]) => ({ group, ...value, shards: value.shards.slice().sort((left, right) => left.blockShard - right.blockShard) }));
}

export async function resolveSparseCoverage(bucket: R2Bucket, surface: ForecastSurfaceV5, ctx?: WaitContext, bounds?: readonly number[], waiterSignal?: AbortSignal): Promise<{ coverage: ResolvedSparseCoverage; release: () => void }> {
  waiterSignal?.throwIfAborted();
  const { hash, maskKey } = surface.coverage, prefix = coveragePrefix(hash), cacheKey = hash;
  if (maskKey !== `${prefix}/manifest.json`) throw new CoverageError('Invalid coverage descriptor key');
  let leases = sparseLeases.get(bucket);
  if (!leases) { leases = new Map(); sparseLeases.set(bucket, leases); }
  let lease = leases.get(cacheKey);
  if (!lease) { lease = { refs: 0, loading: false, bytes: 0 }; leases.set(cacheKey, lease); }
  lease.refs++;
  const state = lease;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--state.refs === 0 && !state.loading) { state.release?.(); leases!.delete(cacheKey); }
  };
  try {
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(16, COVERAGE_CACHE_BYTES); caches.set(bucket, cache); }
  let resolved = state.value ?? cache.get(cacheKey) as ResolvedSparseCoverage | undefined;
  if (resolved) {
    countCacheHit(ctx);
    if (!state.release) { state.bytes = sparseRetainedBytes(resolved); state.release = reserveAllocation(state.bytes); }
    state.value = resolved;
  }
  if (!resolved) {
    let reads = flights.get(bucket);
    if (!reads) { reads = new MaterializedReads(2); flights.set(bucket, reads); }
    resolved = await reads.run(cacheKey, async signal => {
      state.loading = true;
      try {
      const { descriptor, tiles } = await resolveSparseTiles(bucket, surface, bounds, ctx);
      signal.throwIfAborted();
      if (descriptor.files.sparse.bytes > MAX_API_SPARSE_BYTES) throw new CoverageError('Sparse coverage exceeds serving byte budget');
      const groups = frameGroups(surface);
      const channelCounts = [...new Set(groups ? groups.map(group => group.channelCount) : [surface.samples.channelCount])];
      const blocks = (descriptor.files.sparse.bytes - 60) / 72;
      const blockBytes = 289 * Math.max(...channelCounts) * 5;
      const maxShards = Math.ceil(blocks * blockBytes / (SAMPLE_SHARD_TARGET_BYTES - blockBytes)) + 1;
      const retained = blocks * (72 + 8 * channelCounts.length) + 4 + tiles.byteLength + estimateJsonBytes(descriptor) + maxShards * 64 * channelCounts.length + 2048;
      if (!Number.isSafeInteger(retained) || retained > COVERAGE_CACHE_BYTES) throw new CoverageError('Sparse coverage exceeds serving byte budget');
      const releaseLoad = reserveAllocation(descriptor.files.sparse.bytes * 2 + retained);
      state.bytes = descriptor.files.sparse.bytes * 2 + retained;
      try {
        const file = descriptor.files.sparse;
        countRead(ctx);
        const blob = await bucket.get(`${prefix}/sparse.bin`);
        if (!blob) throw new CoverageError('Coverage sparse missing');
        const sparse = await readObjectBytes(blob, file.bytes, false, ctx, signal, true);
        if (sparse.length !== file.bytes || await sha256(sparse) !== file.sha256) throw new CoverageError('Coverage sparse hash mismatch');
        const coverage = decodeSparseCoverage(sparse, descriptor.gridHash);
        if (coverage.width !== descriptor.grid.width || coverage.height !== descriptor.grid.height || coverage.wrapLongitude !== descriptor.grid.wrapLongitude || !coverage.blockIds.length) throw new CoverageError('Sparse coverage grid mismatch');
        assertSparseCoverageHalo(coverage);
        const mask: SparseCoverageMask = { grid: descriptor.grid, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, coverage, tiles };
        const layouts = new Map(channelCounts.map(count => [count, prepareShardedSamplePackLayout(mask.grid, coverage.blockIds, count)]));
        const layout = layouts.get(surface.samples.channelCount) ?? layouts.values().next().value!;
        const result = { descriptor, mask, layout, layouts, groups: null };
        const actual = sparseRetainedBytes(result);
        if (actual > retained) throw new CoverageError('Sparse coverage exceeds serving byte budget');
        signal.throwIfAborted();
        cache!.set(cacheKey, result, actual, Date.now() + 3_600_000);
        releaseLoad();
        state.bytes = 0;
        if (state.refs) { state.release = reserveAllocation(actual); state.bytes = actual; state.value = result; }
        return result;
      } finally { releaseLoad(); }
      } finally {
        state.loading = false;
        if (!state.release) state.bytes = 0;
        if (!state.refs) { state.release?.(); leases!.delete(cacheKey); }
      }
    }, ctx, waiterSignal) as ResolvedSparseCoverage;
  }
  const { descriptor, mask } = resolved;
  if (descriptor.id !== surface.coverage.id || descriptor.maxZoom < surface.coverage.maxZoom || descriptor.gridHash !== surface.gridHash || descriptor.gridHash !== surface.coverage.gridHash || !sameGrid(descriptor.grid, surface.grid) || (bounds && JSON.stringify(descriptor.bounds) !== JSON.stringify(bounds))) throw new CoverageError('Coverage geometry disagrees with publication');
  try { assertSampleLayoutBindingV5(surface, { grid: mask.grid, gridHash: descriptor.gridHash, coverageHash: hash, blockIds: mask.coverage.blockIds }); }
  catch { throw new CoverageError('Coverage layout disagrees with publication'); }
  const groups = frameGroups(surface);
  const layouts = resolved.layouts as Map<number, ShardedSamplePackLayout>;
  const channelCounts = groups ? [...new Set(groups.map(group => group.channelCount))] : [surface.samples.channelCount];
  for (const count of channelCounts) if (!layouts.has(count)) {
    const blocks = mask.coverage.blockIds.length, blockBytes = 289 * count * 5;
    const maximum = blocks * 8 + (Math.ceil(blocks * blockBytes / (SAMPLE_SHARD_TARGET_BYTES - blockBytes)) + 1) * 64;
    if (sparseRetainedBytes(resolved) + maximum > COVERAGE_CACHE_BYTES) throw new CoverageError('Sparse coverage exceeds serving byte budget');
    const releaseExtra = reserveAllocation(maximum);
    try {
      const added = prepareShardedSamplePackLayout(mask.grid, mask.coverage.blockIds, count);
      const actual = added.indexBytes + added.shards.length * 64;
      if (actual > maximum) throw new CoverageError('Sparse coverage exceeds serving byte budget');
      layouts.set(count, added);
      const previous = state.release;
      state.release = () => { previous?.(); releaseExtra(); };
      state.bytes += maximum;
      cache.set(cacheKey, resolved, sparseRetainedBytes(resolved), Date.now() + 3_600_000);
    } catch (error) { releaseExtra(); throw error; }
  }
  const layout = layouts.get(surface.samples.channelCount) ?? layouts.values().next().value!;
  if (groups) {
    for (const group of groups) {
      const bound = layouts.get(group.channelCount)!;
      if (bound.shards.length !== group.shards.length || bound.shards.some((shard, i) => shard.firstBlock !== group.shards[i].firstBlock || shard.blockCount !== group.shards[i].blockCount || shard.byteLength !== group.shards[i].bytes)) throw new CoverageError('Coverage shard layout disagrees with publication');
    }
  } else if (layout.shards.length !== surface.samples.shards.length || layout.shards.some((shard, i) => shard.firstBlock !== surface.samples.shards[i].firstBlock || shard.blockCount !== surface.samples.shards[i].blockCount || shard.byteLength !== surface.samples.shards[i].bytes)) throw new CoverageError('Coverage shard layout disagrees with publication');
  return { coverage: { ...resolved, layout, groups }, release };
  } catch (error) { release(); throw error; }
}

function sparseRetainedBytes(value: ResolvedSparseCoverage): number {
  const { coverage, tiles } = value.mask;
  let bytes = coverage.blockIds.byteLength + coverage.offsets.byteLength + coverage.output.byteLength + coverage.halo.byteLength
    + tiles.byteLength + estimateJsonBytes(value.descriptor) + 2048;
  for (const layout of value.layouts.values()) bytes += layout.indexBytes + layout.shards.length * 64;
  return bytes;
}
