import { MAX_COVERAGE_DESCRIPTOR_BYTES, MAX_SPARSE_COVERAGE_BYTES, assertProfileLayoutBindingV5, assertSampleLayoutBindingV5, assertSparseCoverageHalo, canonicalGridJson, sparseCoverageDescriptorSchema, coveragePrefix, decodeSparseCoverage, sameGrid, type ForecastSurfaceV5, type SparseCoverageDescriptor, type SparseCoverageMask } from '@av/contracts';
import { SAMPLE_SHARD_TARGET_BYTES, prepareShardedSamplePackLayout, type ShardedSamplePackLayout } from '@av/forecast';
import { getR2Object, countCacheHit, ByteCache, MaterializedReads, readObjectBytes, readBoundedStream, parseBoundedJson, reserveAllocation, estimateJsonBytes, type WaitContext } from './resources';

export class CoverageError extends Error {}
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
  layouts: ReadonlyMap<number, ShardedSamplePackLayout>;
  groups: readonly FrameGroup[] | null;
}
interface SparseTiles { descriptor: SparseCoverageDescriptor; tiles: Uint8Array }
const caches = new WeakMap<R2Bucket, ByteCache<string, ResolvedSparseCoverage | SparseTiles>>();
const flights = new WeakMap<R2Bucket, MaterializedReads<ResolvedSparseCoverage | SparseTiles>>();
const scalarBindings = new WeakMap<ResolvedSparseCoverage, WeakSet<ForecastSurfaceV5>>();
const profileBindings = new WeakMap<ResolvedSparseCoverage, WeakSet<ForecastSurfaceV5>>();
const tileFlights = new WeakMap<R2Bucket, MaterializedReads<SparseTiles>>();
const COVERAGE_CACHE_BYTES = 24 * 1024 * 1024;
// Each configured native/fine surface retains a mask and tile entry; the byte cap stays fixed.
const COVERAGE_CACHE_ENTRIES = 32;
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

function coverageCache(): Cache | undefined {
  return (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches?.default;
}

function coverageBlobUrl(digest: string): string {
  return `https://coverage.av/blob/${digest}`;
}

async function matchVerifiedBlob(digest: string, limit: number, signal: AbortSignal, reserved: boolean): Promise<Uint8Array | undefined> {
  const cache = coverageCache();
  if (!cache || !/^[a-f0-9]{64}$/.test(digest)) return undefined;
  let hit: Response | undefined;
  try { hit = await cache.match(new Request(coverageBlobUrl(digest))); }
  catch { return undefined; }
  if (!hit?.body) return undefined;
  try {
    signal.throwIfAborted();
    const length = hit.headers.get('content-length');
    if (length !== null && (!Number.isSafeInteger(Number(length)) || Number(length) <= 0 || Number(length) > limit)) {
      await hit.body.cancel();
      return undefined;
    }
    const bytes = await readBoundedStream(hit.body, limit, undefined, { signal, reserved });
    return bytes.byteLength ? bytes : undefined;
  } catch {
    void hit.body.cancel().catch(() => {});
    signal.throwIfAborted();
    return undefined;
  }
}

async function rememberVerifiedBlob(digest: string, bytes: Uint8Array): Promise<void> {
  const cache = coverageCache();
  if (!cache) return;
  let release: () => void;
  try { release = reserveAllocation(bytes.byteLength * 2); }
  catch { return; }
  try {
    await cache.put(new Request(coverageBlobUrl(digest)), new Response(bytes, {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) }
    }));
  } catch { /* Cache population is optional. */ }
  finally { release(); }
}

/** Verified bytes stay in the Cache API under their SHA-256. The in-memory cache remains the hot path. */
async function readVerifiedBlob(bucket: R2Bucket, key: string, digest: string, limit: number, ctx: WaitContext | undefined, signal: AbortSignal, label: string, reserved = false): Promise<Uint8Array> {
  signal.throwIfAborted();
  const cached = await matchVerifiedBlob(digest, limit, signal, reserved);
  signal.throwIfAborted();
  if (cached && await sha256(cached) === digest) {
    signal.throwIfAborted();
    countCacheHit(ctx);
    return cached;
  }
  const object = await getR2Object(bucket, key, ctx);
  if (!object) throw new CoverageError(`${label} missing`);
  const bytes = await readObjectBytes(object, limit, false, ctx, signal, reserved);
  if (await sha256(bytes) !== digest) throw new CoverageError(`${label} hash mismatch`);
  signal.throwIfAborted();
  const stored = rememberVerifiedBlob(digest, bytes);
  if (ctx) ctx.waitUntil(stored);
  else await stored;
  signal.throwIfAborted();
  return bytes;
}

export async function resolveSparseTiles(bucket: R2Bucket, surface: ForecastSurfaceV5, bounds?: readonly number[], ctx?: WaitContext, waiterSignal?: AbortSignal): Promise<SparseTiles> {
  waiterSignal?.throwIfAborted();
  const { hash, maskKey } = surface.coverage, prefix = coveragePrefix(hash), cacheKey = `${hash}/tiles`;
  if (maskKey !== `${prefix}/manifest.json`) throw new CoverageError('Invalid coverage descriptor key');
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(COVERAGE_CACHE_ENTRIES, COVERAGE_CACHE_BYTES); caches.set(bucket, cache); }
  let result = cache.get(cacheKey) as SparseTiles | undefined;
  if (result) countCacheHit(ctx);
  if (!result) {
    let reads = tileFlights.get(bucket);
    if (!reads) { reads = new MaterializedReads(2); tileFlights.set(bucket, reads); }
    result = await reads.run(cacheKey, async signal => {
      const bytes = await readVerifiedBlob(bucket, maskKey, hash, MAX_COVERAGE_DESCRIPTOR_BYTES, ctx, signal, 'Coverage descriptor');
      let descriptor: SparseCoverageDescriptor;
      try { descriptor = sparseCoverageDescriptorSchema.parse(parseBoundedJson(bytes)); }
      catch { throw new CoverageError('Invalid sparse coverage descriptor'); }
      if (await sha256(new TextEncoder().encode(canonicalGridJson(descriptor.grid))) !== descriptor.gridHash) throw new CoverageError('Sparse coverage grid hash mismatch');
      const tiles = await readVerifiedBlob(bucket, `${prefix}/tiles.bin`, descriptor.files.tiles.sha256, descriptor.files.tiles.bytes, ctx, signal, 'Coverage tiles');
      if (tiles.length !== descriptor.files.tiles.bytes) throw new CoverageError('Coverage tiles hash mismatch');
      const value = { descriptor, tiles };
      cache!.set(cacheKey, value, tiles.byteLength + bytes.length * 4, Date.now() + 3_600_000);
      return value;
    }, ctx, waiterSignal) as SparseTiles;
  }
  assertSurfaceCoverage(result.descriptor, surface, bounds);
  return result;
}

function assertSurfaceCoverage(descriptor: SparseCoverageDescriptor, surface: ForecastSurfaceV5, bounds?: readonly number[]): void {
  if (descriptor.id !== surface.coverage.id || descriptor.maxZoom < surface.coverage.maxZoom || descriptor.gridHash !== surface.gridHash
      || descriptor.gridHash !== surface.coverage.gridHash || !sameGrid(descriptor.grid, surface.grid)
      || (bounds && JSON.stringify(descriptor.bounds) !== JSON.stringify(bounds))) throw new CoverageError('Coverage geometry disagrees with publication');
}

function bindLayout(coverage: ResolvedSparseCoverage, surface: ForecastSurfaceV5, kind: 'sample' | 'profile'): void {
  const bindings = kind === 'sample' ? scalarBindings : profileBindings;
  let admitted = bindings.get(coverage);
  if (admitted?.has(surface)) return;
  const { mask, descriptor } = coverage;
  const check = kind === 'sample' ? assertSampleLayoutBindingV5 : assertProfileLayoutBindingV5;
  try { check(surface, { grid: mask.grid, gridHash: descriptor.gridHash, coverageHash: surface.coverage.hash, blockIds: mask.coverage.blockIds }); }
  catch { throw new CoverageError(`Coverage ${kind} layout disagrees with publication`); }
  if (!admitted) { admitted = new WeakSet(); bindings.set(coverage, admitted); }
  admitted.add(surface);
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

export async function resolveSparseCoverage(bucket: R2Bucket, surface: ForecastSurfaceV5, ctx?: WaitContext, bounds?: readonly number[], waiterSignal?: AbortSignal, kind: 'sample' | 'profile' = 'sample'): Promise<{ coverage: ResolvedSparseCoverage; release: () => void }> {
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
  if (!cache) { cache = new ByteCache(COVERAGE_CACHE_ENTRIES, COVERAGE_CACHE_BYTES); caches.set(bucket, cache); }
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
      const { descriptor, tiles } = await resolveSparseTiles(bucket, surface, bounds, ctx, signal);
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
        const sparse = await readVerifiedBlob(bucket, `${prefix}/sparse.bin`, file.sha256, file.bytes, ctx, signal, 'Coverage sparse', true);
        if (sparse.length !== file.bytes) throw new CoverageError('Coverage sparse hash mismatch');
        const coverage = decodeSparseCoverage(sparse, descriptor.gridHash);
        if (coverage.width !== descriptor.grid.width || coverage.height !== descriptor.grid.height || coverage.wrapLongitude !== descriptor.grid.wrapLongitude || !coverage.blockIds.length) throw new CoverageError('Sparse coverage grid mismatch');
        assertSparseCoverageHalo(coverage);
        const mask: SparseCoverageMask = { grid: descriptor.grid, bounds: descriptor.bounds, maxZoom: descriptor.maxZoom, coverage, tiles };
        const layouts = new Map(channelCounts.map(count => [count, prepareShardedSamplePackLayout(mask.grid, coverage.blockIds, count)]));
        const result = { descriptor, mask, layouts, groups: null };
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
  const { mask } = resolved;
  assertSurfaceCoverage(resolved.descriptor, surface, bounds);
  bindLayout(resolved, surface, 'sample');
  if (kind === 'profile') bindLayout(resolved, surface, kind);
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
  return { coverage: { ...resolved, groups }, release };
  } catch (error) { release(); throw error; }
}

function sparseRetainedBytes(value: ResolvedSparseCoverage): number {
  const { coverage, tiles } = value.mask;
  let bytes = coverage.blockIds.byteLength + coverage.offsets.byteLength + coverage.output.byteLength + coverage.halo.byteLength
    + tiles.byteLength + estimateJsonBytes(value.descriptor) + 2048;
  for (const layout of value.layouts.values()) bytes += layout.indexBytes + layout.shards.length * 64;
  return bytes;
}
