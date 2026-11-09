import { CELL_BYTES, PROFILE_HEADER_BYTES, PROFILE_LEVEL_BYTES, PROFILE_PACK_FORMAT, SAMPLE_BLOCK_SIZE,
  createRecipeIdentity, createWholeDomainDescriptors, getProduct, gridToGeographic, layerSurface, mapFrameCount,
  manifestV5Schema, publishedSampleResponseSchema, renderedLayers, sourceIntervalHours, type LayerId, type ManifestV5 } from '@av/contracts';
import type { PinnedBuild, SamplePayload } from '@av/contracts/client';
import { profileResponseSchema, type ProfileResponse } from '@av/contracts';
import { deriveSoaringViews } from '@av/soaring';
import { fixtureBuild, fixtureManifest, fixturePatch } from './forecast-fixture';

const PROFILE_LEVELS = 4;
interface PointBuildOptions {
  frameHours?: readonly number[];
  mapFrameCount?: number;
  profiles?: boolean;
  profileLevels?: number;
  layers?: readonly LayerId[];
}

/** GFS fields on a tiny grid with selectable surfaces and frame axes. */
export function fixturePointBuild(options: PointBuildOptions = {}): PinnedBuild {
  const base = fixtureManifest(), product = getProduct('gfs');
  if (!product || base.grid.kind !== 'regular-latlon') throw new Error('Point fixture requires GFS');
  const { version: _version, grid, coverage, samples: _samples, ...rest } = base;
  const prefix = `builds/gfs/${base.buildId}`, cycle = Date.parse(base.cycle), frameHours = options.frameHours ?? product.frameHours;
  const count = options.mapFrameCount ?? mapFrameCount({ frameHours, mapEndHour: product.mapEndHour });
  const frames = frameHours.map(hour => ({ id: `f${String(hour).padStart(3, '0')}`,
    validTime: new Date(cycle + hour * 3600000).toISOString(), intervalEnd: new Date(cycle + hour * 3600000).toISOString(),
    intervalStart: new Date(cycle + (hour - sourceIntervalHours(product, hour)) * 3600000).toISOString() }));
  const layers = [...(options.layers ?? product.layers)], descriptors = createWholeDomainDescriptors(product);
  const surface = (kind: 'fine' | 'native') => {
    const id = `gfs-${kind}`, hash = (kind === 'fine' ? 'b' : 'a').repeat(64);
    const source = kind === 'fine' ? { ...grid, width: grid.width * 2, height: grid.height * 2, dx: grid.dx / 2, dy: grid.dy / 2 } : grid;
    const selected = layers.filter(layer => layerSurface(layer) === kind);
    const blockCount = Math.ceil(source.width / 16) * Math.ceil(source.height / 16), channelCount = selected.length * (kind === 'fine' ? count : frames.length);
    return { id, kind, grid: source, gridHash: hash, coverage: { ...coverage, id, hash, gridHash: hash, maskKey: `coverage/${hash}/manifest.json`, maxZoom: kind === 'fine' ? 9 : 7 },
      layers: selected, samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer',
        channelCount, coverageHash: hash, blockCount, storedCells: blockCount,
        shards: [{ firstBlock: 0, blockCount, storedCells: blockCount, bytes: blockCount * channelCount * CELL_BYTES, key: `${prefix}/surfaces/${id}/samples/0.bin`, sha256: hash }] },
      ...(kind === 'fine' ? { terrain: { dataId: hash, key: `terrain/prepared/${hash}/manifest.json`, sha256: hash,
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash: hash, coverageHash: hash, layoutVersion: 1 } } : {}) };
  };
  const manifest = manifestV5Schema.parse({ ...rest, version: 5, descriptors, frames, mapFrameCount: count, layers,
    recipe: createRecipeIdentity(product, 'a'.repeat(64)),
    method: { ...base.method, id: [...new Set(layers.map(layer => descriptors.layers[layer].methodId))].join('+') },
    surfaces: [surface('native'), surface('fine')].filter(item => item.layers.length),
    artifacts: frames.slice(0, count).flatMap(frame => renderedLayers(layers).map(layer => ({ layer, frame: frame.id,
      tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'a'.repeat(64) }))) });
  if (options.profiles) attachProfiles(manifest, prefix, options.profileLevels);
  return { manifest, expiresAtMs: Date.parse(manifest.expiresAt), templates: Object.fromEntries(renderedLayers(layers).map(layer =>
    [layer, `https://api.test/tiles/gfs/${manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])) };
}

/** Declare a native profile pack without the artifact bookkeeping the builder never serves. */
function attachProfiles(manifest: ManifestV5, prefix: string, levels = PROFILE_LEVELS): void {
  const native = manifest.surfaces.find(surface => surface.kind === 'native');
  if (!native) return;
  const recordBytes = PROFILE_HEADER_BYTES + levels * PROFILE_LEVEL_BYTES;
  const frames = manifest.frames.length, totalBlocks = native.samples.blockCount;
  const shardBlocks = Math.max(1, Math.floor((64 * 1024 * 1024) / (frames * recordBytes)));
  const shards = [];
  for (let firstBlock = 0, index = 0; firstBlock < totalBlocks; index++) {
    const blockCount = Math.min(shardBlocks, totalBlocks - firstBlock);
    shards.push({ firstBlock, blockCount, storedCells: blockCount, bytes: blockCount * frames * recordBytes,
      key: `${prefix}/surfaces/${native.id}/profiles/g0-b${index}.bin`, sha256: 'a'.repeat(64) });
    firstBlock += blockCount;
  }
  native.profiles = {
    format: PROFILE_PACK_FORMAT, blockSize: SAMPLE_BLOCK_SIZE, levelCount: levels, recordBytes,
    coverageHash: native.coverage.hash, blockCount: native.samples.blockCount, storedCells: native.samples.storedCells,
    groups: [{ firstFrame: 0, frameCount: frames, shards }]
  };
}

/** Profile-backed tiny GFS grid. */
export function fixtureProfileBuild(options: Omit<PointBuildOptions, 'profiles'> = {}): PinnedBuild {
  return fixturePointBuild({ ...options, profiles: true });
}

const retainedHours = [...Array.from({ length: 24 }, (_, i) => i + 1), ...Array.from({ length: 120 }, (_, i) => 27 + i * 3)];

/** Retained GFS publication with a 24-hour map prefix and 384-hour native horizon. */
export function retainedPointBuild(): PinnedBuild {
  return fixturePointBuild({ frameHours: retainedHours, mapFrameCount: 24 });
}

/** Retained GFS publication whose native surface also serves column profiles. */
export function retainedProfileBuild(): PinnedBuild {
  return fixtureProfileBuild({ frameHours: retainedHours, mapFrameCount: 24 });
}

/** Retained single-surface reader with the same long forecast axis. */
export function retainedLegacyPointBuild(version: 3 | 4 = 4): PinnedBuild {
  const base = fixtureManifest({ layers: ['usable-lift-agl'], frames: retainedPointBuild().manifest.frames });
  return fixtureBuild({ ...base, version, ...(version === 4 ? { patches: [fixturePatch(base)] } : {}) });
}

/** Reply only with requested cells; fine fields become unavailable outside the map prefix. */
export function fixturePointSample(build: PinnedBuild, input: string): SamplePayload {
  const m = build.manifest;
  if (m.version !== 5) throw new Error('Point fixture requires v5');
  const url = new URL(input), frames = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',') as LayerId[];
  const values = FIXTURE_LAYER_VALUES;
  return publishedSampleResponseSchema.parse({ version: 5, model: m.model, buildId: m.buildId,
    lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')), method: m.method, source: m.source, expiresAt: m.expiresAt,
    surfaces: m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
    frames: m.frames.filter(frame => frames.includes(frame.id)).map(frame => ({ ...frame, layers: Object.fromEntries(layers.map(layer => {
      const owner = m.surfaces.find(surface => surface.layers.includes(layer))!;
      const unavailable = owner.kind === 'fine' && m.frames.indexOf(frame) >= (m.mapFrameCount ?? m.frames.length);
      return [layer, { value: unavailable ? null : values[layer] ?? 0, status: unavailable ? 'unavailable' : 'valid',
        support: 0, interpolated: false, surfaceId: owner.id }];
    })) })) });
}

const FIXTURE_LAYER_VALUES: Partial<Record<LayerId, number>> = { 'usable-lift-msl': 2000, 'usable-lift-agl': 500,
  'thermal-velocity': 2, 'thermal-top-msl': 2500, 'surface-lcl-msl': 3000, 'cloud-cover-total': 0,
  'wind-10m-u': 3, 'wind-10m-v': 4, 'bl-mean-wind-u': 2, 'bl-mean-wind-v': 1 };

/** Native profile column served for the same tiny grid as the scalar fixture. */
export function fixtureProfileResponse(build: PinnedBuild, input: string): ProfileResponse {
  const m = build.manifest;
  if (m.version !== 5) throw new Error('Profile fixture requires v5');
  const native = m.surfaces.find(surface => surface.kind === 'native');
  if (!native?.profiles) throw new Error('Profile fixture requires a native profile pack');
  const url = new URL(input), frames = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',') as LayerId[];
  const point = gridToGeographic(native.grid, 0, 0);
  const levels = [
    { pressureHpa: 900, heightM: 1800, temperatureC: 12, dewPointC: 2, uWindMps: 3, vWindMps: 4, omegaPaS: -0.1 },
    { pressureHpa: 850, heightM: 2400, temperatureC: 8, dewPointC: 0, uWindMps: 4, vWindMps: 5, omegaPaS: -0.2 },
    { pressureHpa: 800, heightM: 3000, temperatureC: 4, dewPointC: -2, uWindMps: 6, vWindMps: 6, omegaPaS: -0.3 },
    { pressureHpa: 750, heightM: 3600, temperatureC: 0, dewPointC: -6, uWindMps: 8, vWindMps: 7, omegaPaS: -0.4 }
  ];
  const derived = { ...deriveSoaringViews({ terrainM: 1500, thermalTopM: 2500, thermalVelocityMps: 2, thermalTopRhPercent: 55,
    surfaceLclM: 3000, mixedLayerLclM: 2900, effectiveCloudLimitM: 2800, wind10mU: 3, wind10mV: 4,
    blMeanWindU: 2, blMeanWindV: 1, blTopWindU: 5, blTopWindV: 5 }), usableLiftTopV2M: 2500, mixedLayerLclM: 2900, effectiveCloudLimitM: 2800 };
  return profileResponseSchema.parse({ version: 1, model: m.model, buildId: m.buildId, cycle: m.cycle, createdAt: m.createdAt,
    expiresAt: m.expiresAt, lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')),
    method: m.method, source: m.source, cell: point ? { index: 0, lat: point.lat, lon: point.lon, surfaceId: native.id } : null,
    frames: m.frames.filter(frame => frames.includes(frame.id)).map(frame => ({ ...frame,
      layers: Object.fromEntries(layers.map(layer => [layer, { value: FIXTURE_LAYER_VALUES[layer] ?? 0, status: 'valid',
        support: 0, interpolated: false, surfaceId: native.id }])),
      profile: { modelTerrainM: 1500, surfacePressureHpa: 910, status: 'valid' as const, levels },
      derived })) });
}

/** Fetch stub that answers both point routes of a v5 build. */
export function fixturePointFetch(build: PinnedBuild, input: string): unknown {
  return new URL(input).pathname.endsWith('/profile') ? fixtureProfileResponse(build, input) : fixturePointSample(build, input);
}
