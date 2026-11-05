import { CELL_BYTES, createRecipeIdentity, createWholeDomainDescriptors, getProduct, layerSurface, mapFrameCount,
  manifestV5Schema, publishedSampleResponseSchema, renderedLayers, sourceIntervalHours, type LayerId } from '@av/contracts';
import type { PinnedBuild, SamplePayload } from '@av/contracts/client';
import { fixtureManifest } from './forecast-fixture';

/** Production GFS axes and fields on a tiny two-surface test grid. */
export function fixturePointBuild(): PinnedBuild {
  const base = fixtureManifest(), product = getProduct('gfs');
  if (!product || base.grid.kind !== 'regular-latlon') throw new Error('Point fixture requires GFS');
  const { version: _version, grid, coverage, samples: _samples, ...rest } = base;
  const prefix = `builds/gfs/${base.buildId}`, cycle = Date.parse(base.cycle), count = mapFrameCount(product);
  const frames = product.frameHours.map(hour => ({ id: `f${String(hour).padStart(3, '0')}`,
    validTime: new Date(cycle + hour * 3600000).toISOString(), intervalEnd: new Date(cycle + hour * 3600000).toISOString(),
    intervalStart: new Date(cycle + (hour - sourceIntervalHours(product, hour)) * 3600000).toISOString() }));
  const layers = [...product.layers], descriptors = createWholeDomainDescriptors(product);
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
    surfaces: [surface('native'), surface('fine')],
    artifacts: frames.slice(0, count).flatMap(frame => renderedLayers(layers).map(layer => ({ layer, frame: frame.id,
      tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'a'.repeat(64) }))) });
  return { manifest, expiresAtMs: Date.parse(manifest.expiresAt), templates: Object.fromEntries(renderedLayers(layers).map(layer =>
    [layer, `https://api.test/tiles/gfs/${manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])) };
}

/** Reply only with requested cells; fine fields become unavailable outside the map prefix. */
export function fixturePointSample(build: PinnedBuild, input: string): SamplePayload {
  const m = build.manifest;
  if (m.version !== 5) throw new Error('Point fixture requires v5');
  const url = new URL(input), frames = url.searchParams.get('frame')!.split(','), layers = url.searchParams.get('layers')!.split(',') as LayerId[];
  const values: Partial<Record<LayerId, number>> = { 'usable-lift-msl': 2000, 'usable-lift-agl': 500,
    'thermal-velocity': 2, 'thermal-top-msl': 2500, 'surface-lcl-msl': 3000, 'cloud-cover-total': 0,
    'wind-10m-u': 3, 'wind-10m-v': 4, 'bl-mean-wind-u': 2, 'bl-mean-wind-v': 1 };
  return publishedSampleResponseSchema.parse({ version: 5, model: m.model, buildId: m.buildId,
    lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')), method: m.method, source: m.source, expiresAt: m.expiresAt,
    surfaces: m.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
    frames: m.frames.filter(frame => frames.includes(frame.id)).map(frame => ({ ...frame, layers: Object.fromEntries(layers.map(layer => {
      const owner = m.surfaces.find(surface => surface.layers.includes(layer))!;
      const unavailable = owner.kind === 'fine' && m.frames.indexOf(frame) >= (m.mapFrameCount ?? m.frames.length);
      return [layer, { value: unavailable ? null : values[layer] ?? 0, status: unavailable ? 'unavailable' : 'valid',
        support: 0, interpolated: true, surfaceId: owner.id }];
    })) })) });
}
