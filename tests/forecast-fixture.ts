import raw from '../scripts/fixtures/manifest.contract.json' with { type: 'json' };
import { CELL_BYTES, computeFreshness, getProvenanceReference, latestSchema, manifestSchema, refinementPatchSchema, validateArtifactRecords, type Manifest, type RefinementPatch } from '@av/contracts';
import type { PinnedBuild } from '@av/contracts/client';

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

export function fixtureLatest(overrides: Partial<Manifest> = {}, baseUrl = 'https://api.test') {
  const manifest = fixtureManifest(overrides);
  return latestSchema.parse({
    pointer: { version: 1, model: manifest.model, latestBuildId: manifest.buildId, retained: [{ buildId: manifest.buildId, manifestKey: `builds/${manifest.model}/${manifest.buildId}/manifest.json`, cycle: manifest.cycle, expiresAt: manifest.expiresAt }] },
    manifest,
    templates: Object.fromEntries(manifest.layers.map(layer => [layer, `${baseUrl}/tiles/${manifest.model}/${manifest.buildId}/${layer}/{frame}/{z}/{x}/{y}.webp`])),
    freshness: computeFreshness(manifest, Date.parse(manifest.createdAt))
  });
}

export function fixtureBuild(overrides: Partial<Manifest> = {}, baseUrl = 'https://api.test'): PinnedBuild {
  const { manifest, templates } = fixtureLatest(overrides, baseUrl);
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
