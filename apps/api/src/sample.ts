import { MAX_SAMPLE_RANGE_BYTES, MAX_SAMPLE_POINTS, SAMPLE_STATUSES, STATUS_OUTSIDE, STATUS_UNAVAILABLE, surfaceFrameCount, type ForecastSurfaceV5, type LayerId, type ManifestV5 } from '@av/contracts';
import { packedCellsFromRange, planShardedPackedSample, planSample, sampleCells, samplingCovered, type Cell, type PackedSamplePlan, type Sample } from '@av/forecast';
import { resolveSparseCoverage } from './coverage';
import { MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST, waitFor, reserveAllocation, estimateJsonBytes, type WaitContext } from './resources';
import { servedSource } from './publication';
import { cached, fail, json, response } from './http';
import { readPackedRanges, type PackedRange } from './packed-ranges';
import { readCoordinatePair, readPointCoordinates, sampleChannelGroups, selectSampleFields } from './point-query';

interface Point { lat: number; lon: number }

function admitSampleValues(m: ManifestV5, url: URL, points = 1): void {
  const requested = url.searchParams.get('frame'), frames = requested === 'all' ? m.frames.length : requested === null ? 1 : requested.split(',').length;
  const layers = url.searchParams.get('layers')?.split(',').length ?? m.layers.length;
  if (points * frames * layers > m.descriptors.maxSampleValues) fail(429, 'sample-limit', `Select at most ${m.descriptors.maxSampleValues} point/frame/layer values`);
}

export async function serveSample(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, url: URL): Promise<Response> {
  const { lat, lon } = readPointCoordinates(url);
  admitSampleValues(m, url);
  const { frames, layers: selectedLayers } = selectSampleFields(m, url);
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('lat', String(lat));
  canonical.searchParams.set('lon', String(lon));
  canonical.searchParams.set('frame', frames.map(f => f.id).join(','));
  canonical.searchParams.set('layers', selectedLayers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const [result] = await readSamples(canonicalRequest, bucket, ctx, m, url.origin, [{ lat, lon }], frames, selectedLayers);
    const digest = await waitFor(crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical.toString())), canonicalRequest.signal);
    const tag = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return json(result, m.expiresAt, `sample-${tag}-v5`);
  }, 'sample-v5');
}

export async function serveSamples(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, url: URL): Promise<Response> {
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
  const canonical = new URL(url.origin + url.pathname);
  canonical.searchParams.set('points', points.map(pointKey).join(';'));
  canonical.searchParams.set('frame', frames.map(frame => frame.id).join(','));
  canonical.searchParams.set('layers', layers.join(','));
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const unique = [...new Map(points.map(point => [pointKey(point), point])).values()];
    const samples = await readSamples(request, bucket, ctx, m, url.origin, unique, frames, layers);
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

interface PointPlan {
  point: number; surface: ForecastSurfaceV5; jobs: ReturnType<typeof sampleChannelGroups>[number]['jobs'];
  plan: ReturnType<typeof planSample>; packed: ReturnType<typeof planShardedPackedSample> | null;
  shard: ForecastSurfaceV5['samples']['shards'][number] | undefined;
  cells: Map<number, Cell[]>;
}
interface SamplePart { plan: PointPlan; packed: PackedSamplePlan; contributors: number[] }
interface SampleRange extends PackedRange { parts: SamplePart[] }

function sampleParts(plan: PointPlan, mode: 'span' | 'rows' | 'records'): SamplePart[] {
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

function sampleRanges(plans: PointPlan[], mode: 'span' | 'rows' | 'records' = 'span'): SampleRange[] {
  const byShard = new Map<string, SamplePart[]>();
  for (const plan of plans) {
    if (!plan.packed || !plan.shard) continue;
    const key = `${plan.shard.key}:${plan.shard.sha256}`, group = byShard.get(key);
    const parts = sampleParts(plan, mode);
    if (group) group.push(...parts); else byShard.set(key, parts);
  }
  const ranges: SampleRange[] = [];
  for (const group of byShard.values()) {
    group.sort((left, right) => left.packed.byteRange.offset - right.packed.byteRange.offset);
    let previous: SampleRange | undefined;
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

async function readSamples(request: Request, bucket: R2Bucket, ctx: WaitContext, m: ManifestV5, origin: string, points: readonly Point[], frames: ManifestV5['frames'], layers: LayerId[]) {
  const releases: (() => void)[] = [];
  try {
    const plans: PointPlan[] = [];
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
    const rangeBytes = (ranges: SampleRange[]) => ranges.reduce((total, range) => total + range.length, 0);
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
      const value = plan && contributors ? sampleCells(plan, contributors, m.descriptors.layers[job.layer], m.tool.useStoredMslNoLift === true)
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
