import { MAX_COVERAGE_DESCRIPTOR_BYTES, coverageDescriptorSchema, coveragePrefix, type CoverageMask, type Manifest } from '@av/contracts';
import { prepareSamplePackLayout, type SamplePackLayout } from '@av/forecast';
import { countRead, countCacheHit, ByteCache, MaterializedReads, readObjectBytes, parseBoundedJson, type WaitContext } from './resources';

export class CoverageError extends Error {}
export interface ResolvedCoverage { id: string; mask: CoverageMask; layout: SamplePackLayout }
const caches = new WeakMap<R2Bucket, ByteCache<string, ResolvedCoverage>>();
const flights = new WeakMap<R2Bucket, MaterializedReads<ResolvedCoverage>>();
export async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>)), b => b.toString(16).padStart(2, '0')).join('');
}

/** Only hash-verified materialized bytes cross request boundaries; R2 bodies never do. */
export async function resolveCoverage(bucket: R2Bucket, manifest: Manifest, ctx?: WaitContext): Promise<ResolvedCoverage> {
  const { hash, maskKey } = manifest.coverage;
  const prefix = coveragePrefix(hash);
  if (maskKey !== `${prefix}/manifest.json`) throw new CoverageError('Invalid coverage descriptor key');
  let cache = caches.get(bucket);
  if (!cache) { cache = new ByteCache(16, 8 * 1024 * 1024); caches.set(bucket, cache); }
  let resolved = cache.get(hash);
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
      const result = { id: descriptor.id, mask, layout };
      // Bitsets plus conservative accounting for layout indexes and parsed descriptor.
      const retainedBytes = output.length + halo.length + tiles.length + Math.ceil(mask.grid.width / 16) * Math.ceil(mask.grid.height / 16) * 32 + bytes.length * 4;
      cache!.set(hash, result, retainedBytes, Date.now() + 3_600_000);
      return result;
    }, ctx);
  }
  if (resolved.id !== manifest.coverage.id || JSON.stringify(resolved.mask.grid) !== JSON.stringify(manifest.grid)
      || resolved.mask.maxZoom !== manifest.coverage.maxZoom
      || JSON.stringify(resolved.mask.bounds) !== JSON.stringify(manifest.descriptors.bounds)
      || resolved.layout.storedCells !== manifest.samples.storedCells) {
    throw new CoverageError('Coverage geometry or sample layout disagrees with publication');
  }
  return resolved;
}
