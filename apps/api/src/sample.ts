import { MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_POINTS, SAMPLE_STATUSES, STATUS_OUTSIDE, STATUS_UNAVAILABLE, surfaceFrameCount, isCovered, type ForecastGrid, type ForecastSurfaceV5, type LayerId, type ManifestV5 } from '@av/contracts';
import { refinementCandidate } from '@av/contracts/refinement';
import { packedCellsFromRange, planPackedSample, planShardedPackedSample, planSample, sampleCells, samplingCovered, type Cell, type PackedSamplePlan, type Sample } from '@av/forecast';
import { resolveCoverage, resolveSparseCoverage, type ResolvedCoverage } from './coverage';
import { MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST, binaryRead, countRead, readObjectBytes, waitFor, reserveAllocation, estimateJsonBytes, type WaitContext } from './resources';
import { artifact, servedSource, type PublishedManifest } from './publication';
import { cached, ensureLive, fail, json, response } from './http';
import { readPackedRanges, type PackedRange } from './packed-ranges';
import { readCoordinatePair, readPointCoordinates, sampleChannelGroups, selectSampleFields } from './point-query';

interface Point { lat: number; lon: number }

function admitSampleValues(m: PublishedManifest, url: URL, points = 1): void {
  const requested = url.searchParams.get('frame'), frames = requested === 'all' ? m.frames.length : requested === null ? 1 : requested.split(',').length;
  const layers = url.searchParams.get('layers')?.split(',').length ?? m.layers.length;
  if (points * frames * layers > m.descriptors.maxSampleValues) fail(429, 'sample-limit', `Select at most ${m.descriptors.maxSampleValues} point/frame/layer values`);
}

export async function serveSample(request: Request, bucket: R2Bucket, ctx: WaitContext, m: PublishedManifest, url: URL): Promise<Response> {
  const { lat, lon } = readPointCoordinates(url);
  admitSampleValues(m, url);
  const { frames, layers: selectedLayers } = selectSampleFields(m, url);
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('lat', String(lat));
  canonical.searchParams.set('lon', String(lon));
  canonical.searchParams.set('frame', frames.map(f => f.id).join(','));
  canonical.searchParams.set('layers', selectedLayers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  if (m.version === 5) return serveSampleV5(canonicalRequest, bucket, ctx, m, url.origin, canonical, lat, lon, frames, selectedLayers);
  for (const frame of frames) for (const layer of selectedLayers) artifact(m, layer, frame.id);
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
          ? sampleCells(plan, packedCellsFromRange(packed, bytes, job.channel), grid.descriptors.layers[job.layer], m.tool.useStoredMslNoLift)
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

export async function serveSamples(request: Request, bucket: R2Bucket, ctx: WaitContext, m: PublishedManifest, url: URL): Promise<Response> {
  const raw = url.searchParams.get('points');
  if (!raw) fail(400, 'invalid-query', 'Select coordinate pairs');
  const pairs = raw.split(';');
  if (pairs.length > MAX_SAMPLE_POINTS) fail(429, 'sample-limit', `Select at most ${MAX_SAMPLE_POINTS} points`);
  const points = pairs.map(pair => {
    const values = pair.split(',');
    if (values.length !== 2) fail(400, 'invalid-query', 'Invalid coordinate pair');
    return readCoordinatePair(values[0], values[1]);
  });
  admitSampleValues(m, url, points.length);
  const { frames, layers } = selectSampleFields(m, url);
  if (m.version !== 5) fail(409, 'unsupported-publication', 'Batch samples require a version-5 build');
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('points', points.map(pointKey).join(';'));
  canonical.searchParams.set('frame', frames.map(frame => frame.id).join(','));
  canonical.searchParams.set('layers', layers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const unique = [...new Map(points.map(point => [pointKey(point), point])).values()];
    const samples = await readSamplesV5(request, bucket, ctx, m, url.origin, unique, frames, layers);
    const byPoint = new Map(samples.map(sample => [pointKey(sample), sample]));
    const result = { version: 1, model: m.model, buildId: m.buildId, expiresAt: m.expiresAt,
      points: points.map((point, index) => ({ index, sample: byPoint.get(pointKey(point))! })) };
    const release = reserveAllocation(Math.max(1024, estimateJsonBytes(result) * 2));
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(result));
      const digest = await waitFor(crypto.subtle.digest('SHA-256', bytes), request.signal);
      const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      return response(bytes, 'application/json; charset=utf-8', m.expiresAt, tag);
    } finally { release(); }
  }, 'samples-v1');
}

const pointKey = ({ lat, lon }: Point) => `${lat},${lon}`;

interface V5Plan {
  point: number; surface: ForecastSurfaceV5; jobs: ReturnType<typeof sampleChannelGroups>[number]['jobs'];
  plan: ReturnType<typeof planSample>; packed: ReturnType<typeof planShardedPackedSample> | null;
  shard: ForecastSurfaceV5['samples']['shards'][number] | undefined;
  cells: Map<number, Cell[]>;
}
interface V5Part { plan: V5Plan; packed: PackedSamplePlan; contributors: number[] }
interface V5Range extends PackedRange { parts: V5Part[] }

function sampleParts(plan: V5Plan, mode: 'span' | 'rows' | 'records'): V5Part[] {
  const packed = plan.packed!;
  const all = packed.contributorRanks.map((_, index) => index);
  if (mode === 'span') return [{ plan, packed, contributors: all }];
  const groups: number[][] = [];
  for (const index of all) {
    const previous = groups.at(-1)?.[0];
    if (mode === 'records' || previous === undefined || plan.plan!.contributors[previous]!.row !== plan.plan!.contributors[index]!.row) groups.push([]);
    groups.at(-1)!.push(index);
  }
  const channels = mode === 'records' ? packed.channels.map(channel => [channel]) : [packed.channels];
  return groups.flatMap(contributors => channels.map(selected => {
    const ranks = contributors.map(index => packed.contributorRanks[index]!);
    const first = Math.min(...ranks), last = Math.max(...ranks), low = Math.min(...selected), high = Math.max(...selected);
    return { plan, contributors, packed: { ...packed, channels: selected, contributorRanks: ranks,
      byteRange: { offset: (first * packed.channelCount + low) * packed.recordBytes,
        length: ((last - first) * packed.channelCount + high - low + 1) * packed.recordBytes } } };
  }));
}

function sampleRanges(plans: V5Plan[], mode: 'span' | 'rows' | 'records' = 'span'): V5Range[] {
  const byShard = new Map<string, V5Part[]>();
  for (const plan of plans) {
    if (!plan.packed || !plan.shard) continue;
    const key = `${plan.shard.key}:${plan.shard.sha256}`, group = byShard.get(key);
    const parts = sampleParts(plan, mode);
    if (group) group.push(...parts); else byShard.set(key, parts);
  }
  const ranges: V5Range[] = [];
  for (const group of byShard.values()) {
    group.sort((left, right) => left.packed.byteRange.offset - right.packed.byteRange.offset);
    let previous: V5Range | undefined;
    for (const part of group) {
      const range = part.packed.byteRange;
      if (previous && range.offset <= previous.offset + previous.length) {
        previous.length = Math.max(previous.length, range.offset + range.length - previous.offset);
        previous.parts.push(part);
      } else { previous = { shard: part.plan.shard!, ...range, parts: [part] }; ranges.push(previous); }
    }
  }
  return ranges;
}

async function readSamplesV5(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, origin: string, points: readonly Point[], frames: ManifestV5['frames'], layers: LayerId[]) {
  const releases: (() => void)[] = [];
  try {
    const plans: V5Plan[] = [];
    const values = points.map(() => new Map<string, Sample & { surfaceId: string }>());
    const pending = [];
    for (const surface of m.surfaces) {
      const selected = layers.filter(layer => surface.layers.includes(layer));
      if (!selected.length) continue;
      const count = surfaceFrameCount(m, surface), available = frames.filter(frame => m.frames.indexOf(frame) < count);
      for (const frame of frames) if (m.frames.indexOf(frame) >= count) for (const point of values) for (const layer of selected) {
        point.set(`${frame.id}/${layer}`, { value: null, status: STATUS_UNAVAILABLE, support: 0, interpolated: false, surfaceId: surface.id });
      }
      if (!available.length) continue;
      pending.push((async () => {
        const lease = await resolveSparseCoverage(bucket, surface, ctx, m.descriptors.bounds, request.signal);
        releases.push(lease.release);
        return { surface, selected, available, coverage: lease.coverage };
      })());
    }
    const loaded = [];
    for (const result of await Promise.allSettled(pending)) {
      if (result.status === 'rejected') throw result.reason;
      loaded.push(result.value);
    }
    request.signal.throwIfAborted();
    for (const { surface, selected, available, coverage } of loaded) {
      const groups = sampleChannelGroups(m, surface, coverage, available, selected);
      for (const [point, { lat, lon }] of points.entries()) {
        const covered = samplingCovered(coverage.mask, lat, lon), plan = covered ? planSample(surface.grid, lat, lon) : null;
        if (covered && !plan) fail(503, 'publication-invalid', 'Surface coverage lacks sample support');
        for (const { jobs, layout, channels, shards } of groups) {
          let packed: ReturnType<typeof planShardedPackedSample> | null = null;
          try { if (plan) packed = planShardedPackedSample(layout, plan, channels, shards); }
          catch { fail(503, 'publication-invalid', 'Invalid sample layout'); }
          const shard = packed ? shards[packed.shard] : undefined;
          if (packed && !shard) fail(503, 'publication-invalid', 'Invalid sample range');
          plans.push({ point, surface, jobs, plan, packed, shard, cells: new Map() });
        }
      }
    }
    const rangeBytes = (ranges: V5Range[]) => ranges.reduce((total, range) => total + range.length, 0);
    let ranges = sampleRanges(plans);
    // Keep one-wave reads narrow; scattered queries split further to retain the byte budget.
    if (ranges.length <= MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST || rangeBytes(ranges) > MAX_SAMPLE_RANGE_BYTES) {
      const rows = sampleRanges(plans, 'rows');
      if (rows.length === ranges.length || rangeBytes(ranges) > MAX_SAMPLE_RANGE_BYTES
          || rows.length <= MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST && rangeBytes(ranges) - rangeBytes(rows) >= 4096) ranges = rows;
    }
    if (rangeBytes(ranges) > MAX_SAMPLE_RANGE_BYTES) ranges = sampleRanges(plans, 'records');
    await readPackedRanges(bucket, ctx, request.signal, m.expiresAt, 'sample', ranges, (range, bytes) => {
      for (const part of range.parts) {
        const selected = part.packed.byteRange, offset = selected.offset - range.offset;
        const contents = bytes.subarray(offset, offset + selected.length);
        for (const channel of part.packed.channels) {
          let cells = part.plan.cells.get(channel);
          if (!cells) { cells = new Array(part.plan.plan!.contributors.length); part.plan.cells.set(channel, cells); }
          const decoded = packedCellsFromRange(part.packed, contents, channel);
          for (const [index, contributor] of part.contributors.entries()) cells[contributor] = decoded[index]!;
        }
      }
    });
    for (const { point, surface, jobs, plan, packed, cells } of plans) for (const job of jobs) {
      const contributors = cells.get(job.channel);
      if (packed && (!contributors || packed.contributorRanks.some((_, index) => !contributors[index]))) fail(503, 'publication-invalid', 'Sample range lacks a contributor');
      const value = plan && contributors ? sampleCells(plan, contributors, m.descriptors.layers[job.layer], m.tool.useStoredMslNoLift)
        : { value: null, status: STATUS_OUTSIDE, support: 0, interpolated: false };
      values[point]!.set(`${job.frameId}/${job.layer}`, { ...value, surfaceId: surface.id });
    }
    const source = servedSource(m, origin), surfaces = m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage }));
    return points.map(({ lat, lon }, point) => ({
      version: 5 as const, model: m.model, buildId: m.buildId, lat, lon, method: m.method, source, surfaces, expiresAt: m.expiresAt,
      frames: frames.map(frame => ({ ...frame, layers: Object.fromEntries(layers.map(layer => {
        const value = values[point]!.get(`${frame.id}/${layer}`);
        if (!value) fail(503, 'publication-invalid', 'Sample surface lacks selected frame or layer');
        return [layer, { ...value, status: SAMPLE_STATUSES[value.status] }];
      })) }))
    }));
  } finally { for (const release of releases) release(); }
}

async function serveSampleV5(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, origin: string, canonical: URL, lat: number, lon: number, frames: ManifestV5['frames'], layers: LayerId[]): Promise<Response> {
  return cached(request, m.expiresAt, ctx, async () => {
    const [result] = await readSamplesV5(request, bucket, ctx, m, origin, [{ lat, lon }], frames, layers);
    const digest = await waitFor(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toString())), request.signal);
    const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return json(result, m.expiresAt, `sample-${tag}-v5`);
  }, 'sample-v5');
}
