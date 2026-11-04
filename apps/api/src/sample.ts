import { MAX_SAMPLE_RANGE_BYTES, SAMPLE_STATUSES, STATUS_OUTSIDE, isCovered, isLayerId, type ForecastGrid, type ForecastSurfaceV5, type LayerId, type ManifestV5 } from '@av/contracts';
import { refinementCandidate } from '@av/contracts/refinement';
import { packedCellsFromRange, planPackedSample, planShardedPackedSample, planSample, sampleCells, type Sample } from '@av/forecast';
import { resolveCoverage, resolveSparseCoverage, type ResolvedCoverage } from './coverage';
import { MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST, binaryRead, countRead, readObjectBytes, waitFor, type WaitContext } from './resources';
import { artifact, servedSource, type PublishedManifest } from './publication';
import { cached, ensureLive, fail, json } from './http';

export async function serveSample(request: Request, bucket: R2Bucket, ctx: WaitContext, m: PublishedManifest, url: URL): Promise<Response> {
  const coordinate = (name: string, min: number, max: number) => {
    const value = url.searchParams.get(name);
    if (value === null || value.trim() === '' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
      fail(400, 'invalid-query', `Invalid ${name}`);
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n < min || n > max) fail(400, 'invalid-query', `Invalid ${name}`);
    return Object.is(n, -0) ? 0 : n;
  };
  const lat = coordinate('lat', -90, 90),
    lon = coordinate('lon', -180, 180);
  const requested = url.searchParams.get('frame');
  const frameIds = requested === 'all' ? m.frames.map(f => f.id) : requested === null ? [m.frames[0].id] : requested.split(',');
  const layers = url.searchParams.get('layers')?.split(',') ?? [...m.layers];
  if (frameIds.length * layers.length > m.descriptors.maxSampleValues) fail(429, 'sample-limit', `Select at most ${m.descriptors.maxSampleValues} frame/layer values`);
  if (!frameIds.length || !layers.length || new Set(frameIds).size !== frameIds.length || new Set(layers).size !== layers.length) {
    fail(400, 'invalid-query', 'Select distinct frames and layers');
  }
  const selectedLayers = layers.map(layer => {
    if (!isLayerId(layer)) fail(404, 'unknown-layer', 'Unknown layer');
    return layer;
  }).sort();
  const frames = frameIds
    .map(id => {
      const f = m.frames.find(frame => frame.id === id);
      if (!f) return fail(404, 'unknown-frame', 'Unknown frame');
      return f;
    })
    .sort((a, b) => a.validTime.localeCompare(b.validTime));
  for (const frame of frames) for (const layer of selectedLayers) artifact(m, layer, frame.id);
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('lat', String(lat));
  canonical.searchParams.set('lon', String(lon));
  canonical.searchParams.set('frame', frames.map(f => f.id).join(','));
  canonical.searchParams.set('layers', selectedLayers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  if (m.version === 5) return serveSampleV5(canonicalRequest, bucket, ctx, m, url.origin, canonical, lat, lon, frames, selectedLayers);
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const base = await resolveCoverage(bucket, m, ctx, request.signal), outside = !isCovered(base.mask, lat, lon);
    const resolved = new Map<ForecastGrid, ResolvedCoverage>([[m, base]]);
    const groups = new Map<ForecastGrid, { layers: LayerId[]; patchId?: string }>();
    for (const layer of selectedLayers) {
      let grid: ForecastGrid = m, patchId: string | undefined;
      const patch = outside ? undefined : refinementCandidate(m.patches ?? [], layer, lat, lon);
      if (patch) {
        let coverage = resolved.get(patch);
        if (!coverage) { coverage = await resolveCoverage(bucket, patch, ctx, request.signal); resolved.set(patch, coverage); }
        if (isCovered(coverage.mask, lat, lon)) { grid = patch; patchId = patch.id; }
      }
      const group = groups.get(grid);
      if (group) group.layers.push(layer);
      else groups.set(grid, { layers: [layer], ...(patchId ? { patchId } : {}) });
    }
    let rangeBytes = 0;
    const plans = [...groups].map(([grid, group]) => {
      const jobs = frames.flatMap(frame => group.layers.map(layer => ({ frame, layer, channel: m.frames.indexOf(frame) * grid.layers.length + grid.layers.indexOf(layer) })));
      const plan = outside ? null : planSample(grid.grid, lat, lon);
      if (!plan && group.patchId) fail(503, 'publication-invalid', 'Refinement coverage lacks sample support');
      const packed = plan ? planPackedSample(resolved.get(grid)!.layout, plan, grid.samples.channelCount, jobs.map(job => job.channel)) : null;
      if (packed) {
        const { offset, length } = packed.byteRange;
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset + length > grid.samples.bytes) {
          fail(503, 'publication-invalid', 'Invalid sample range');
        }
        rangeBytes += length;
      }
      return { grid, patchId: group.patchId, jobs, plan, packed };
    });
    if (rangeBytes > MAX_SAMPLE_RANGE_BYTES) fail(429, 'sample-limit', 'Selected sample ranges exceed the byte budget');
    const source = servedSource(m, url.origin);
    const values = new Map<string, Sample & { patchId?: string }>();
    for (const { grid, patchId, jobs, plan, packed } of plans) {
      let bytes: Uint8Array = new Uint8Array();
      if (packed) {
        bytes = await binaryRead(bucket, `${grid.samples.key}:${packed.byteRange.offset}:${packed.byteRange.length}`, async signal => {
          countRead(ctx);
          const object = await bucket.get(grid.samples.key, { range: packed.byteRange });
          if (!object || !('body' in object)) fail(503, 'publication-incomplete', 'Sample pack missing or invalid');
          if (object.size !== grid.samples.bytes) {
            void object.body.cancel().catch(() => {});
            fail(503, 'publication-incomplete', 'Sample pack missing or invalid');
          }
          return readObjectBytes(object, packed.byteRange.length, true, ctx, signal);
        }, ctx, request.signal);
        ensureLive(m.expiresAt);
        if (bytes.byteLength !== packed.byteRange.length) fail(503, 'publication-incomplete', 'Incomplete sample range');
      }
      for (const job of jobs) {
        const value = plan && packed
          ? sampleCells(plan, packedCellsFromRange(packed, bytes, job.channel), grid.descriptors.layers[job.layer])
          : { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
        values.set(`${job.frame.id}/${job.layer}`, { ...value, ...(patchId ? { patchId } : {}) });
      }
    }
    const result = {
      model: m.model,
      buildId: m.buildId,
      lat,
      lon,
      method: m.method,
      source,
      coverage: m.coverage,
      expiresAt: m.expiresAt,
      frames: frames.map(frame => ({
        ...frame,
        layers: Object.fromEntries(
          selectedLayers.map(layer => {
            const value = values.get(`${frame.id}/${layer}`)!;
            return [layer, { ...value, status: SAMPLE_STATUSES[value.status] }];
          })
        )
      }))
    };
    const digest = await waitFor(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toString())), request.signal);
    const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return json(result, m.expiresAt, `sample-${tag}-v4`);
  }, 'sample-v4');
}

async function serveSampleV5(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, origin: string, canonical: URL, lat: number, lon: number, frames: ManifestV5['frames'], layers: LayerId[]): Promise<Response> {
  return cached(request, m.expiresAt, ctx, async () => {
    const releases: (() => void)[] = [];
    try {
    const plans: { surface: ForecastSurfaceV5; jobs: { frame: ManifestV5['frames'][number]; layer: LayerId; channel: number }[]; plan: ReturnType<typeof planSample>; packed: ReturnType<typeof planShardedPackedSample> | null; shard: ForecastSurfaceV5['samples']['shards'][number] | undefined }[] = [];
    let rangeBytes = 0;
    for (const surface of m.surfaces) {
      const selected = layers.filter(layer => surface.layers.includes(layer));
      if (!selected.length) continue;
      const lease = await resolveSparseCoverage(bucket, surface, ctx, m.descriptors.bounds, request.signal);
      releases.push(lease.release);
      request.signal.throwIfAborted();
      const coverage = lease.coverage;
      const covered = isCovered(coverage.mask, lat, lon);
      const plan = covered ? planSample(surface.grid, lat, lon) : null;
      if (covered && !plan) fail(503, 'publication-invalid', 'Surface coverage lacks sample support');
      const groups = coverage.groups ?? [{ firstFrame: 0, frameCount: m.frames.length, channelCount: surface.samples.channelCount, shards: surface.samples.shards }];
      for (const group of groups) {
        const jobs = frames.filter(frame => { const index = m.frames.indexOf(frame); return index >= group.firstFrame && index < group.firstFrame + group.frameCount; })
          .flatMap(frame => selected.map(layer => ({ frame, layer, channel: (m.frames.indexOf(frame) - group.firstFrame) * surface.layers.length + surface.layers.indexOf(layer) })));
        if (!jobs.length) continue;
        let packed: ReturnType<typeof planShardedPackedSample> | null = null;
        try { if (plan) packed = planShardedPackedSample(coverage.layouts.get(group.channelCount)!, plan, jobs.map(job => job.channel)); }
        catch { fail(503, 'publication-invalid', 'Invalid sample layout'); }
        const shard = packed ? group.shards[packed.shard] : undefined;
        if (packed) {
          const { offset, length } = packed.byteRange;
          if (!shard || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || !Number.isSafeInteger(offset + length) || offset + length > shard.bytes) fail(503, 'publication-invalid', 'Invalid sample range');
          rangeBytes += length;
        }
        plans.push({ surface, jobs, plan, packed, shard });
      }
    }
    if (rangeBytes > MAX_SAMPLE_RANGE_BYTES) fail(429, 'sample-limit', 'Selected sample ranges exceed the byte budget');
    const values = new Map<string, Sample & { surfaceId: string }>();
    let next = 0, failure: unknown;
    const work = async () => { for (;;) {
      if (failure || next >= plans.length) return;
      const { surface, jobs, plan, packed, shard } = plans[next++];
      try {
      let bytes: Uint8Array = new Uint8Array();
      if (packed) {
        const record = shard!, range = packed.byteRange;
        bytes = await binaryRead(bucket, `${record.key}:${record.sha256}:${range.offset}:${range.length}`, async signal => {
          countRead(ctx);
          const object = await bucket.get(record.key, { range });
          if (!object || !('body' in object)) fail(503, 'publication-incomplete', 'Sample shard missing or invalid');
          if (object.size !== record.bytes || object.customMetadata?.sha256 !== record.sha256 || !object.range || !('offset' in object.range) || object.range.offset !== range.offset || !('length' in object.range) || object.range.length !== range.length) {
            void object.body.cancel().catch(() => {});
            fail(503, 'publication-incomplete', 'Sample shard metadata or range mismatch');
          }
          return readObjectBytes(object, range.length, true, ctx, signal);
        }, ctx, request.signal);
        ensureLive(m.expiresAt);
        if (bytes.byteLength !== range.length) fail(503, 'publication-incomplete', 'Incomplete sample range');
      }
      for (const job of jobs) {
        const value = plan && packed ? sampleCells(plan, packedCellsFromRange(packed, bytes, job.channel), m.descriptors.layers[job.layer]) : { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
        values.set(`${job.frame.id}/${job.layer}`, { ...value, surfaceId: surface.id });
      }
      } catch (error) { failure ??= error; return; }
    } };
    await Promise.all(Array.from({ length: Math.min(plans.length, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST) }, work));
    if (failure) throw failure;
    const result = {
      version: 5, model: m.model, buildId: m.buildId, lat, lon, method: m.method, source: servedSource(m, origin),
      surfaces: m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })), expiresAt: m.expiresAt,
      frames: frames.map(frame => ({ ...frame, layers: Object.fromEntries(layers.map(layer => {
        const value = values.get(`${frame.id}/${layer}`)!;
        return [layer, { ...value, status: SAMPLE_STATUSES[value.status] }];
      })) }))
    };
    const digest = await waitFor(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toString())), request.signal);
    const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return json(result, m.expiresAt, `sample-${tag}-v5`);
    } finally { for (const release of releases) release(); }
  }, 'sample-v5');
}
