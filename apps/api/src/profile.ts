/** Serve bounded profiles and scalar diagnostics from one covered native cell. */
import {
  SAMPLE_STATUSES, MAX_POINT_RESPONSE_BYTES, estimateProfileResponseBytes, assertProfileLayoutBindingV5,
  prepareGridGeometry, sparseCoverageLookup, type LayerId, type ManifestV5
} from '@av/contracts';
import {
  packedCellsFromRange, packedRecordsFromRange, planSample, planShardedPackedSample,
  prepareShardedSamplePackLayout, readProfileRecord, sampleCells, samplingCovered, type NativeProfile,
  type SamplePlan
} from '@av/forecast';
import { nativeColumnHumidityAtHeight, nativeColumnCloudDiagnostics, nativeColumnWindAtHeight, deriveSoaringViews } from '@av/soaring';
import { resolveSparseCoverage, sha256 } from './coverage';
import { reserveAllocation, waitFor, type WaitContext } from './resources';
import { cached, fail, response } from './http';
import { readPackedRanges, type PackedRange } from './packed-ranges';
import { servedSource, type PublishedManifest } from './publication';
import { readPointCoordinates, selectSampleFields } from './point-query';

interface ReadJob extends PackedRange { apply(bytes: Uint8Array): void }

export async function serveProfile(request: Request, bucket: R2Bucket, ctx: WaitContext, manifest: PublishedManifest, url: URL): Promise<Response> {
  if (manifest.version !== 5) fail(409, 'profile-unavailable', 'This build has no native profiles');
  const m: ManifestV5 = manifest, surface = m.surfaces.find(item => item.kind === 'native');
  if (!surface?.profiles) fail(409, 'profile-unavailable', 'This build has no native profiles');
  const profiles = surface.profiles, { lat, lon } = readPointCoordinates(url);
  const { frames, layers } = selectSampleFields(m, url, surface.layers);
  if (layers.some(layer => !surface.layers.includes(layer))) fail(400, 'invalid-query', 'Profile layers must belong to the native surface');
  const estimated = estimateProfileResponseBytes(frames.length, profiles.levelCount, layers.length);
  if (estimated > MAX_POINT_RESPONSE_BYTES) fail(429, 'sample-limit', 'Select fewer profile frames or layers');
  const canonical = new URL(url.origin + url.pathname);
  for (const [key, value] of Object.entries({ lat: String(lat), lon: String(lon), frame: frames.map(frame => frame.id).join(','), layers: layers.join(',') })) canonical.searchParams.set(key, value);
  const canonicalRequest = new Request(canonical, { headers: request.headers, signal: request.signal });
  return cached(canonicalRequest, m.expiresAt, ctx, async () => {
    const releases: (() => void)[] = [reserveAllocation(estimated)];
    try {
      const lease = await resolveSparseCoverage(bucket, surface, ctx, m.descriptors.bounds, request.signal);
      releases.push(lease.release);
      const { coverage } = lease;
      assertProfileLayoutBindingV5(surface, { grid: surface.grid, gridHash: surface.gridHash, coverageHash: surface.coverage.hash, blockIds: coverage.mask.coverage.blockIds });
      const geometry = prepareGridGeometry(surface.grid);
      const neighborhood = samplingCovered(coverage.mask, lat, lon) ? planSample(surface.grid, lat, lon) : null;
      const donor = neighborhood?.contributors.filter(cell => sparseCoverageLookup(coverage.mask.coverage, cell.column, cell.row)?.output).sort((a, b) => b.weight - a.weight)[0];
      const point = donor ? geometry.gridToGeographic(donor.column, donor.row) : null;
      const cell = donor && point ? { index: donor.index, lat: point.lat, lon: point.lon, surfaceId: surface.id } : null;
      const plan: SamplePlan | null = donor && cell ? { contributors: [{ ...donor, weight: 1 }], byteRange: { offset: 0, length: 0 } } : null;
      const values = new Map<string, Record<string, unknown>>(), columns = new Map<string, NativeProfile>(), jobs: ReadJob[] = [];
      for (const frame of frames) {
        values.set(frame.id, Object.fromEntries(layers.map(layer => [layer, { value: null, status: 'outside-domain', support: 0, interpolated: false, surfaceId: surface.id }])));
        columns.set(frame.id, { modelTerrainM: null, surfacePressureHpa: null, status: 'outside-domain', levels: [] });
      }
      if (plan) {
        const sampleGroups = coverage.groups ?? [{ firstFrame: 0, frameCount: m.frames.length, channelCount: surface.samples.channelCount, shards: surface.samples.shards }];
        for (const group of sampleGroups) {
          const selected = frames.filter(frame => { const index = m.frames.indexOf(frame); return index >= group.firstFrame && index < group.firstFrame + group.frameCount; });
          if (!selected.length) continue;
          const channels = selected.flatMap(frame => layers.map(layer => (m.frames.indexOf(frame) - group.firstFrame) * surface.layers.length + surface.layers.indexOf(layer)));
          const packed = planShardedPackedSample(coverage.layouts.get(group.channelCount)!, plan, channels, group.shards), shard = group.shards[packed.shard]!;
          jobs.push({ shard, ...packed.byteRange, apply(bytes) {
            for (const frame of selected) for (const layer of layers) {
              const channel = (m.frames.indexOf(frame) - group.firstFrame) * surface.layers.length + surface.layers.indexOf(layer);
              const sample = sampleCells(plan, packedCellsFromRange(packed, bytes, channel), m.descriptors.layers[layer]);
              values.get(frame.id)![layer] = { ...sample, status: SAMPLE_STATUSES[sample.status], surfaceId: surface.id };
            }
          } });
        }
        const layouts = new Map<number, ReturnType<typeof prepareShardedSamplePackLayout>>();
        for (const group of profiles.groups) {
          const shards = group.shards, selected = frames.filter(frame => { const index = m.frames.indexOf(frame); return index >= group.firstFrame && index < group.firstFrame + group.frameCount; });
          if (!selected.length) continue;
          let layout = layouts.get(group.frameCount);
          if (!layout) {
            const maximum = coverage.mask.coverage.blockIds.length * 8 + shards.length * 64;
            releases.push(reserveAllocation(maximum));
            layout = prepareShardedSamplePackLayout(surface.grid, coverage.mask.coverage.blockIds, group.frameCount, undefined, profiles.recordBytes);
            if (layout.indexBytes + layout.shards.length * 64 > maximum) fail(503, 'publication-invalid', 'Profile layout exceeds its allocation');
            layouts.set(group.frameCount, layout);
          }
          const packed = planShardedPackedSample(layout, plan, selected.map(frame => m.frames.indexOf(frame) - group.firstFrame), shards), shard = shards[packed.shard]!;
          jobs.push({ shard, ...packed.byteRange, apply(bytes) {
            for (const frame of selected) {
              try { columns.set(frame.id, readProfileRecord(packedRecordsFromRange(packed, bytes, m.frames.indexOf(frame) - group.firstFrame)[0]!)); }
              catch { fail(503, 'publication-invalid', 'Invalid atmospheric profile record'); }
            }
          } });
        }
      }
      await readPackedRanges(bucket, ctx, request.signal, m.expiresAt, 'profile', jobs, (job, bytes) => job.apply(bytes));
      const result = { version: 1, model: m.model, buildId: m.buildId, cycle: m.cycle, createdAt: m.createdAt, expiresAt: m.expiresAt,
        lat, lon, cell, method: m.method, source: servedSource(m, url.origin), frames: frames.map(frame => {
          const column = columns.get(frame.id)!, fields = values.get(frame.id)!;
          const value = (layer: LayerId): number | null => {
            const sample = fields[layer] as { value: number | null; status: string } | undefined;
            return sample?.status === 'valid' ? sample.value : null;
          };
          const native = { terrainM: column.modelTerrainM ?? NaN, surfacePressureHpa: column.surfacePressureHpa, surfaceTemperatureC: value('sfc-temp-c') ?? NaN,
            surfaceDewPointC: value('sfc-dewpoint-c'), pblHeightM: value('pbl-height-agl'),
            wind10mU: value('wind-10m-u'), wind10mV: value('wind-10m-v'),
            levels: column.levels.map(level => ({ ...level, heightM: level.heightM ?? NaN, temperatureC: level.temperatureC ?? NaN,
              uMps: level.uWindMps, vMps: level.vWindMps })) };
          const thermalTopM = value('thermal-top-msl'), terrainM = column.modelTerrainM;
          const layerTop = terrainM === null ? null : thermalTopM !== null && thermalTopM > terrainM ? thermalTopM
            : native.pblHeightM !== null && native.pblHeightM >= 0 ? terrainM + native.pblHeightM : thermalTopM === terrainM ? terrainM : null;
          const thermalTopRhPercent = nativeColumnHumidityAtHeight(native, thermalTopM);
          const cloud = nativeColumnCloudDiagnostics(native, layerTop), wind = nativeColumnWindAtHeight(native, layerTop);
          const derived = deriveSoaringViews({ terrainM, thermalTopM, thermalVelocityMps: value('thermal-velocity'),
            thermalTopRhPercent, surfaceLclM: value('surface-lcl-msl'), mixedLayerLclM: cloud.mixedLayerLclM,
            effectiveCloudLimitM: cloud.effectiveCloudLimitM, wind10mU: native.wind10mU, wind10mV: native.wind10mV,
            blMeanWindU: value('bl-mean-wind-u'), blMeanWindV: value('bl-mean-wind-v'), blTopWindU: wind.blTopWindU, blTopWindV: wind.blTopWindV });
          return { ...frame, layers: fields, profile: column,
            derived: { ...derived, mixedLayerLclM: cloud.mixedLayerLclM, effectiveCloudLimitM: cloud.effectiveCloudLimitM } };
        }) };
      const body = JSON.stringify(result), encoded = new TextEncoder().encode(body);
      if (encoded.byteLength > MAX_POINT_RESPONSE_BYTES) fail(429, 'sample-limit', 'Profile response exceeds the byte budget');
      return response(encoded, 'application/json; charset=utf-8', m.expiresAt, await waitFor(sha256(encoded), request.signal));
    } finally { for (const release of releases) release(); }
  }, 'profile-v1');
}
