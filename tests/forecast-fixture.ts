import raw from '../scripts/fixtures/manifest.contract.json' with { type: 'json' };
import { CELL_BYTES, computeFreshness, getProvenanceReference, latestSchema, manifestSchema, validateArtifactRecords, type Manifest } from '@av/contracts';
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
