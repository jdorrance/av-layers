import { describe, expect, it } from 'vitest';
import { fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture.js';
import { encodeBoundedJson, MAX_MANIFEST_BYTES, parseBoundedJson } from './index.js';
import { forecastGrids, forecastObjects, manifestSchema, validateArtifactRecords, type Manifest } from './publication.js';

function refined(): Manifest {
  const manifest = fixtureManifest();
  return manifestSchema.parse({ ...manifest, version: 4, patches: [fixturePatch(manifest)] });
}

describe('refined forecast publications', () => {
  it('round-trips v3 and v4 without changing the public model, frame axis or raster archive paths', () => {
    for (const manifest of [fixtureManifest(), refined()]) {
      const decoded = manifestSchema.parse(parseBoundedJson(encodeBoundedJson(manifest, MAX_MANIFEST_BYTES)));
      expect(decoded).toEqual(manifest);
      expect(() => validateArtifactRecords(decoded)).not.toThrow();
    }
    const base = fixtureManifest(), manifest = refined();
    expect(manifest.model).toBe(base.model);
    expect(manifest.frames).toEqual(base.frames);
    expect(manifest.artifacts).toEqual(base.artifacts);
    expect(forecastGrids(manifest)).toEqual([manifest, manifest.patches![0]]);
    expect(forecastObjects(manifest).map(object => object.key)).toEqual([
      base.samples.key, manifest.patches![0].samples.key, ...base.artifacts.map(artifact => artifact.tilesKey)
    ]);
  });

  it('requires a matching version and a nonempty, bounded patch list', () => {
    const manifest = refined();
    expect(manifestSchema.safeParse({ ...manifest, version: 3 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, patches: undefined }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, patches: [] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...manifest, patches: new Array(17).fill(manifest.patches![0]) }).success).toBe(false);
  });

  it.each(['layers', 'path', 'channels', 'bytes', 'zoom', 'coverage', 'method', 'method-hash', 'limit'] as const)('rejects a patch with mismatched %s before reading assets', defect => {
    const manifest = refined(), patch = manifest.patches![0];
    if (defect === 'layers') patch.layers.push('usable-lift-agl');
    if (defect === 'path') patch.samples.key = manifest.samples.key;
    if (defect === 'channels') patch.samples.channelCount++;
    if (defect === 'bytes') patch.samples.bytes++;
    if (defect === 'zoom') patch.coverage.maxZoom--;
    if (defect === 'coverage') patch.coverage.maskKey = manifest.coverage.maskKey;
    if (defect === 'method') patch.method.id = manifest.method.id;
    if (defect === 'method-hash') patch.method.hash = 'e'.repeat(64);
    if (defect === 'limit') patch.descriptors.maxSampleValues = 1;
    expect(() => validateArtifactRecords(manifest)).toThrow(/refinement/i);
  });

  it('rejects overlapping patch ownership and unsupported parent layers', () => {
    const manifest = refined();
    manifest.patches!.push(fixturePatch(manifest, { id: 'zone-002' }));
    expect(() => validateArtifactRecords(manifest)).toThrow(/overlap|touch/);
    const noRain = fixtureManifest({ layers: ['usable-lift-msl', 'usable-lift-agl'] });
    noRain.version = 4;
    noRain.patches = [fixturePatch(noRain, { layers: ['precip-rate'] })];
    expect(() => validateArtifactRecords(noRain)).toThrow(/refinement/i);
  });
});
