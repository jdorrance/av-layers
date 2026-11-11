import raw from '../scripts/fixtures/manifest.contract.json' with { type: 'json' };
import { getProduct } from '@av/contracts/models';
import { CELL_BYTES, computeFreshness, createRecipeIdentity, createWholeDomainDescriptors, getProvenanceReference,
  latestV5Schema, layerSurface, manifestSchema, manifestV5Schema, planWholeDomainGrid, refinementPatchSchema,
  renderedLayers, SAMPLE_BLOCK_SIZE, validateArtifactRecords, type Manifest, type ManifestV5, type RefinementPatch } from '@av/contracts';
import type { PinnedBuild } from '@av/client';

/** Start valid; tests corrupt individual fields only after constructing a fixture. */
export function fixtureManifest(overrides: Partial<Manifest> = {}): Manifest {
  const value = { ...structuredClone(raw), ...overrides };
  const prefix = `builds/${value.model}/${value.buildId}`;
  const channelCount = value.frames.length * value.layers.length;
  const manifest = manifestSchema.parse({
    ...value,
    artifacts: overrides.artifacts ?? value.frames.flatMap(frame => value.layers.map(layer => ({ layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'a'.repeat(64) }))),
    samples: { ...value.samples, channelCount, bytes: value.samples.storedCells * channelCount * CELL_BYTES, key: `${prefix}/samples.bin` },
    source: { ...value.source, provenanceKey: `${prefix}/provenance.json` }
  });
  if (!overrides.method) manifest.method.id = [...new Set(manifest.layers.map(layer => manifest.descriptors.layers[layer].methodId))].join('+');
  validateArtifactRecords(manifest);
  getProvenanceReference(manifest);
  return manifest;
}

export const FIXTURE_BUILD_ID = raw.buildId;

/** Whole-domain publication metadata for browser and discovery tests. */
export function fixtureManifestV5(overrides: Partial<ManifestV5> = {}): ManifestV5 {
  const { grid: _grid, coverage: _coverage, samples: _samples, patches: _patches, ...base } = fixtureManifest();
  const model = overrides.model ?? base.model;
  const product = getProduct(model) ?? getProduct(base.model)!;
  const buildId = overrides.buildId ?? base.buildId, prefix = `builds/${model}/${buildId}`;
  const frames = overrides.frames ?? base.frames, layers = overrides.layers ?? base.layers;
  const count = overrides.mapFrameCount ?? frames.length;
  const descriptors = overrides.descriptors ?? createWholeDomainDescriptors(product);
  const grids = planWholeDomainGrid(product.grid, 2);
  const surfaces = (['native', 'fine'] as const).flatMap(kind => {
    const selected = layers.filter(layer => layerSurface(layer) === kind);
    if (!selected.length) return [];
    const id = `${model}-${kind}`, grid = grids[kind], hash = (kind === 'native' ? 'a' : 'b').repeat(64);
    const blockCount = Math.ceil(grid.width / SAMPLE_BLOCK_SIZE) * Math.ceil(grid.height / SAMPLE_BLOCK_SIZE);
    const channelCount = selected.length * (kind === 'fine' ? count : frames.length);
    return [{
      id, kind, grid, gridHash: hash,
      coverage: { id, hash, gridHash: hash, maskKey: `coverage/${hash}/manifest.json`, maxZoom: kind === 'fine' ? 9 : 7 },
      layers: selected,
      samples: {
        format: 'cell-major-block-shards-v1', blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer',
        channelCount, coverageHash: hash, blockCount, storedCells: blockCount,
        shards: [{ firstBlock: 0, blockCount, storedCells: blockCount, bytes: blockCount * channelCount * CELL_BYTES,
          key: `${prefix}/surfaces/${id}/samples/0.bin`, sha256: hash }]
      },
      ...(kind === 'fine' ? { terrain: { dataId: hash, key: `terrain/prepared/${hash}/manifest.json`, sha256: hash,
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash: hash, coverageHash: hash, layoutVersion: 1 } } : {})
    }];
  });
  const artifacts = frames.slice(0, count).flatMap(frame => renderedLayers(layers, descriptors.layers).map(layer => ({
    layer, frame: frame.id, tilesKey: `${prefix}/${layer}/${frame.id}.pmtiles`, tilesSha256: 'a'.repeat(64)
  })));
  return manifestV5Schema.parse({
    ...base, ...overrides, version: 5, model, buildId, frames, layers, descriptors,
    surfaces: overrides.surfaces ?? surfaces, artifacts: overrides.artifacts ?? artifacts,
    recipe: overrides.recipe ?? createRecipeIdentity(product, 'a'.repeat(64)),
    method: overrides.method ?? { ...base.method, id: [...new Set(layers.map(layer => descriptors.layers[layer].methodId))].join('+') },
    source: { ...base.source, ...overrides.source, provenanceKey: `${prefix}/provenance.json` }
  });
}

export function fixtureLatest(manifest = fixtureManifestV5(), baseUrl = 'https://api.test') {
  return latestV5Schema.parse({
    pointer: { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{ buildId: manifest.buildId, manifestKey: `builds/${manifest.model}/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt }] },
    manifest,
    templates: Object.fromEntries(renderedLayers(manifest.layers, manifest.descriptors.layers).map(layer => [layer,
      `${baseUrl}/tiles/${manifest.model}/${manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifest, Date.parse(manifest.createdAt))
  });
}

export function fixtureBuild(overrides: Partial<ManifestV5> = {}, baseUrl = 'https://api.test'): PinnedBuild {
  const { manifest, templates } = fixtureLatest(fixtureManifestV5(overrides), baseUrl);
  return { manifest: manifest!, templates: templates! as PinnedBuild['templates'], expiresAtMs: Date.parse(manifest!.expiresAt) };
}

/** A synthetic terrain-AGL surface; callers supply stored coverage and sample bytes when needed. */
export function fixturePatch(manifest: Manifest, overrides: Partial<RefinementPatch> = {}): RefinementPatch {
  const baseLayer = manifest.descriptors.layers['usable-lift-agl'];
  if (!baseLayer) throw new Error('Refinement fixture requires the AGL layer');
  const method = { ...structuredClone(manifest.descriptors.methods[baseLayer.methodId]), id: 'fixture-terrain-clearance', outputs: ['usable-lift-agl'] };
  const id = overrides.id ?? 'zone-001', hash = 'b'.repeat(64), bounds = [-0.008, -0.008, 0.008, 0.008];
  return refinementPatchSchema.parse({
    id,
    grid: { kind: 'lambert-conformal', width: 3, height: 3, earthRadiusM: 6371229, centralMeridianDeg: 0, latitudeOfOriginDeg: 0, standardParallel1Deg: 1, standardParallel2Deg: 1, x0M: -1000, y0M: 1000, dxM: 1000, dyM: -1000, wrapLongitude: false },
    coverage: { id: 'fixture-refinement', hash, maskKey: `coverage/${hash}/manifest.json`, maxZoom: manifest.coverage.maxZoom },
    geometry: { type: 'Polygon', coordinates: [[[-0.008, -0.008], [0.008, -0.008], [0.008, 0.008], [-0.008, 0.008], [-0.008, -0.008]]] },
    descriptors: { ...structuredClone(manifest.descriptors), bounds,
      layers: { 'usable-lift-agl': { ...baseLayer, methodId: method.id, verticalReference: 'terrain-AGL', label: 'Usable lift depth (terrain AGL)' } },
      methods: { [method.id]: method }, palettes: manifest.descriptors.palettes.filter(palette => palette.id === baseLayer.palette) },
    layers: ['usable-lift-agl'], method: { id: method.id, hash: manifest.method.hash },
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 9, channelCount: manifest.frames.length, bytes: 9 * manifest.frames.length * CELL_BYTES, key: `builds/${manifest.model}/${manifest.buildId}/refinements/${id}/samples.bin`, sha256: hash },
    terrain: { dataId: 'c'.repeat(64), key: `terrain/prepared/${hash}/manifest.json`, sha256: hash, verticalDatum: 'EGM2008', surface: 'DSM' },
    ...overrides
  });
}
