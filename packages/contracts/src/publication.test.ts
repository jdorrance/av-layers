import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture.js';
import { encodeBoundedJson, MAX_MANIFEST_BYTES, PROFILE_HEADER_BYTES, PROFILE_LEVEL_BYTES, PROFILE_PACK_FORMAT, methodDescriptorSchema, parseBoundedJson, TERRAIN_COLUMN_METHOD } from './index.js';
import { assertProfileLayoutBindingV5, assertSampleLayoutBindingV5, forecastGrids, forecastObjects, forecastObjectsV5, manifestSchema, manifestV5Schema, parseFrameProvenance, publishedManifestSchema, publishedSampleResponseSchema, sampleResponseSchema, sampleResponseV5Schema, validateArtifactRecords, validateArtifactRecordsV5, type Manifest, type ManifestV5 } from './publication.js';

function refined(): Manifest {
  const manifest = fixtureManifest();
  return manifestSchema.parse({ ...manifest, version: 4, patches: [fixturePatch(manifest)] });
}

it('requires advertised precipitation support when API and rollback verify a frame receipt', () => {
  const manifest = fixtureManifest(), frame = manifest.frames[0]!;
  const identity = { model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle };
  const window = { start: frame.intervalStart, end: frame.intervalEnd };
  const chunk = { version: 1, ...identity, frame, hour: (Date.parse(frame.validTime) - Date.parse(manifest.cycle)) / 3_600_000,
    intervals: { profileTime: frame.validTime, fluxWindow: window }, receipt: {} };
  expect(() => parseFrameProvenance(chunk, manifest, frame)).toThrow('does not match');
  expect(parseFrameProvenance(chunk, identity, frame)).toEqual(chunk);
  expect(parseFrameProvenance(chunk, { ...identity, layers: ['usable-lift-msl'] }, frame)).toEqual(chunk);
  const complete = { ...chunk, intervals: { ...chunk.intervals, precipitationWindow: window } };
  expect(parseFrameProvenance(complete, manifest, frame)).toEqual(complete);
  const invalid = { ...complete, intervals: { ...complete.intervals, precipitationWindow: { ...window, start: frame.intervalEnd } } };
  for (const binding of [identity, manifest]) expect(() => parseFrameProvenance(invalid, binding, frame)).toThrow('does not match');
});

it('binds provenance frame values independently of input key order', () => {
  const manifest = fixtureManifest(), frame = manifest.frames[0]!;
  const expected = { intervalEnd: frame.intervalEnd, validTime: frame.validTime, id: frame.id, intervalStart: frame.intervalStart };
  const window = { start: frame.intervalStart, end: frame.intervalEnd };
  const chunk = { version: 1, model: manifest.model, buildId: manifest.buildId, cycle: manifest.cycle,
    hour: (Date.parse(frame.validTime) - Date.parse(manifest.cycle)) / 3_600_000,
    frame: { validTime: frame.validTime, intervalStart: frame.intervalStart, intervalEnd: frame.intervalEnd, id: frame.id },
    intervals: { profileTime: frame.validTime, fluxWindow: window, precipitationWindow: window }, receipt: {} };
  expect(parseFrameProvenance(chunk, manifest, expected).frame).toEqual(frame);
  expect(() => parseFrameProvenance(chunk, manifest, { ...expected, intervalStart: frame.intervalEnd })).toThrow('does not match');
});

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

function v5(): ManifestV5 {
  const base = fixtureManifest(), hash = 'b'.repeat(64), gridHash = 'c'.repeat(64);
  const prefix = `builds/${base.model}/${base.buildId}`;
  const grid = { ...base.grid, width: 34, height: 17, wrapLongitude: false };
  const terrainIdentity = { dataId: hash, gridHash, method: 'bilinear-native-v1', coverageHash: hash, layoutVersion: 1 };
  const terrainKeyHash = createHash('sha256').update(JSON.stringify(terrainIdentity)).digest('hex');
  const terrainHash = createHash('sha256').update(JSON.stringify({ ...terrainIdentity, files: { elevationM: [], valid: [] } })).digest('hex');
  const descriptors = structuredClone(base.descriptors);
  for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) descriptors.layers[layer].methodId = TERRAIN_COLUMN_METHOD.id;
  descriptors.layers['usable-lift-agl'].verticalReference = 'terrain-AGL';
  descriptors.methods = { [TERRAIN_COLUMN_METHOD.id]: methodDescriptorSchema.parse(TERRAIN_COLUMN_METHOD), [descriptors.layers['precip-rate'].methodId]: descriptors.methods[descriptors.layers['precip-rate'].methodId] };
  const surface = (id: 'native' | 'fine') => {
    const layers = id === 'native' ? ['precip-rate'] : ['usable-lift-msl', 'usable-lift-agl'];
    const channelCount = base.frames.length * layers.length;
    return {
      id, kind: id, grid, gridHash,
      coverage: { id, hash, gridHash, maskKey: `coverage/${hash}/coverage.bin`, maxZoom: 7 }, layers,
      samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount,
        coverageHash: hash, blockCount: 3, storedCells: 340,
        shards: [289, 51].map((storedCells, i) => ({ firstBlock: i === 0 ? 0 : 1, blockCount: i === 0 ? 1 : 2,
          storedCells, bytes: storedCells * channelCount * 5, key: `${prefix}/surfaces/${id}/samples/${i}.bin`, sha256: hash })) },
      ...(id === 'fine' ? { terrain: { dataId: hash, key: `terrain/prepared/${terrainKeyHash}/manifest.json`, sha256: terrainHash,
        verticalDatum: 'EGM2008', surface: 'DSM', gridHash, coverageHash: hash, layoutVersion: 1 } } : {})
    };
  };
  return manifestV5Schema.parse({
    version: 5, descriptors, recipe: base.recipe, model: base.model, buildId: base.buildId,
    cycle: base.cycle, createdAt: base.createdAt, expiresAt: base.expiresAt,
    method: { ...base.method, id: `${TERRAIN_COLUMN_METHOD.id}+${descriptors.layers['precip-rate'].methodId}` },
    frames: base.frames, layers: base.layers, artifacts: base.artifacts, source: base.source,
    tool: base.tool, palettes: base.palettes, metrics: base.metrics, surfaces: [surface('native'), surface('fine')]
  });
}

describe('v5 forecast publications', () => {
  it('binds uneven frame groups to complete surface-specific block partitions', () => {
    const manifest = v5();
    for (const surface of manifest.surfaces) {
      const old = surface.samples;
      const shards = [3, 5].flatMap((frameCount, group) => old.shards.map((shard, blockShard) => ({
        ...shard, group, firstFrame: group === 0 ? 0 : 3, frameCount, blockShard,
        bytes: shard.storedCells * frameCount * surface.layers.length * 5,
        key: `builds/${manifest.model}/${manifest.buildId}/surfaces/${surface.id}/samples/g${group}-b${blockShard}.bin`
      })));
      surface.samples = { ...old, format: 'frame-group-block-shards-v1', shards };
    }
    expect(manifestV5Schema.parse(manifest)).toEqual(manifest);
    for (const surface of manifest.surfaces) expect(() => assertSampleLayoutBindingV5(surface, {
      grid: surface.grid, gridHash: surface.gridHash, coverageHash: surface.coverage.hash, blockIds: [0, 2, 3]
    })).not.toThrow();
    const invalid = (mutate: (shards: Extract<ManifestV5['surfaces'][number]['samples'], { format: 'frame-group-block-shards-v1' }>['shards']) => void) => {
      const copy = structuredClone(manifest), samples = copy.surfaces[1].samples;
      if (samples.format !== 'frame-group-block-shards-v1') throw new Error('Expected grouped samples');
      mutate(samples.shards);
      expect(manifestV5Schema.safeParse(copy).success).toBe(false);
    };
    invalid(shards => { shards[2].firstFrame++; });
    invalid(shards => { shards[2].group++; });
    invalid(shards => { shards[3].blockShard++; });
    invalid(shards => { shards[2].firstBlock++; });
    invalid(shards => { shards[2].bytes++; });
    invalid(shards => { shards[2].key = shards[2].key.replace('/fine/', '/native/'); });
    invalid(shards => { shards.pop(); });
    expect(manifestV5Schema.safeParse({ ...manifest, buildId: '../invalid' }).success).toBe(false);
  });

  it('round-trips native rain and fine lift with frame-then-layer channels and shard references', () => {
    const manifest = v5();
    expect(manifestV5Schema.parse(parseBoundedJson(encodeBoundedJson(manifest, MAX_MANIFEST_BYTES)))).toEqual(manifest);
    expect(() => validateArtifactRecordsV5(manifest)).not.toThrow();
    expect(manifestSchema.safeParse(manifest).success).toBe(false);
    expect(forecastObjectsV5(manifest).map(object => object.key)).toEqual([
      ...manifest.surfaces.flatMap(surface => surface.samples.shards.map(shard => shard.key)),
      ...manifest.artifacts.map(artifact => artifact.tilesKey)
    ]);
    for (const surface of manifest.surfaces) expect(() => assertSampleLayoutBindingV5(surface, {
      grid: surface.grid, gridHash: surface.gridHash, coverageHash: surface.coverage.hash, blockIds: [0, 2, 3]
    })).not.toThrow();
  });

  it('admits a fine-only lift product', () => {
    const manifest = v5();
    manifest.model = 'icon-eu';
    manifest.layers = ['usable-lift-msl', 'usable-lift-agl'];
    manifest.method.id = TERRAIN_COLUMN_METHOD.id;
    manifest.surfaces = [manifest.surfaces[1]];
    const prefix = `builds/${manifest.model}/${manifest.buildId}`;
    manifest.surfaces[0].samples.shards.forEach((shard, i) => { shard.key = `${prefix}/surfaces/fine/samples/${i}.bin`; });
    manifest.artifacts = manifest.artifacts.filter(artifact => artifact.layer !== 'precip-rate');
    for (const artifact of manifest.artifacts) artifact.tilesKey = `${prefix}/${artifact.layer}/${artifact.frame}.pmtiles`;
    delete manifest.descriptors.layers['precip-rate'];
    delete manifest.descriptors.methods['trailing-precipitation-rate-v1'];
    expect(manifestV5Schema.safeParse(manifest).success).toBe(true);
  });

  it.each(['duplicate-owner', 'wrong-grid', 'missing-layer', 'layer-order', 'coverage', 'grid-hash', 'terrain', 'terrain-key', 'channel-order', 'channels', 'gap', 'overlap', 'shard-size', 'shard-key', 'digest', 'overflow', 'artifact', 'legacy-fields'] as const)('rejects malformed %s metadata', defect => {
    const manifest = v5(), native = manifest.surfaces[0], fine = manifest.surfaces[1];
    if (defect === 'duplicate-owner') fine.layers.push('precip-rate');
    if (defect === 'wrong-grid') native.layers = ['usable-lift-msl'];
    if (defect === 'missing-layer') fine.layers.pop();
    if (defect === 'layer-order') fine.layers.reverse();
    if (defect === 'coverage') fine.samples.coverageHash = 'e'.repeat(64);
    if (defect === 'grid-hash') fine.coverage.gridHash = 'e'.repeat(64);
    if (defect === 'terrain') fine.terrain!.coverageHash = 'e'.repeat(64);
    if (defect === 'terrain-key') fine.terrain!.key = native.coverage.maskKey;
    if (defect === 'channel-order') (fine.samples as { channelOrder: string }).channelOrder = 'layer-then-frame';
    if (defect === 'channels') fine.samples.channelCount++;
    if (defect === 'gap') fine.samples.shards[1].firstBlock++;
    if (defect === 'overlap') fine.samples.shards[1].firstBlock--;
    if (defect === 'shard-size') fine.samples.shards[0].bytes++;
    if (defect === 'shard-key') fine.samples.shards[0].key = native.samples.shards[0].key;
    if (defect === 'digest') fine.samples.shards[0].sha256 = 'bad';
    if (defect === 'overflow') fine.samples.shards[1].storedCells = Number.MAX_SAFE_INTEGER;
    if (defect === 'artifact') manifest.artifacts[0].tilesKey = manifest.artifacts[1].tilesKey;
    if (defect === 'legacy-fields') (manifest as Record<string, unknown>).coverage = native.coverage;
    expect(manifestV5Schema.safeParse(manifest).success).toBe(false);
  });

  it('binds ordered block dimensions and clipped terminal blocks to coverage', () => {
    const surface = v5().surfaces[1];
    const binding = { grid: surface.grid, gridHash: surface.gridHash, coverageHash: surface.coverage.hash, blockIds: [0, 2, 3] };
    expect(() => assertSampleLayoutBindingV5(surface, { ...binding, blockIds: [0, 3, 2] })).toThrow(/order/);
    expect(() => assertSampleLayoutBindingV5(surface, { ...binding, blockIds: [0, 1, 3] })).toThrow(/size/);
    expect(() => assertSampleLayoutBindingV5(surface, { ...binding, coverageHash: 'f'.repeat(64) })).toThrow(/identity/);
    expect(() => assertSampleLayoutBindingV5(surface, { ...binding, blockIds: [0, 2, 6] })).toThrow(/order/);
  });
});

function sampleResponseV5() {
  const manifest = v5();
  return sampleResponseV5Schema.parse({
    version: 5, model: manifest.model, buildId: manifest.buildId, lat: 52.5, lon: 13.4,
    method: manifest.method, source: manifest.source, expiresAt: manifest.expiresAt,
    surfaces: manifest.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })),
    frames: manifest.frames.map(frame => ({
      ...frame,
      layers: Object.fromEntries(manifest.surfaces.flatMap(surface => surface.layers.map(layer => [layer, {
        value: 1, status: 'valid', support: 1, interpolated: false, surfaceId: surface.id
      }])))
    }))
  });
}

describe('published transport contracts', () => {
  it('publishes v3, v4 and v5 manifests through one union while leaving legacy schemas unchanged', () => {
    for (const manifest of [fixtureManifest(), refined(), v5()]) {
      expect(publishedManifestSchema.parse(parseBoundedJson(encodeBoundedJson(manifest, MAX_MANIFEST_BYTES)))).toEqual(manifest);
    }
    expect(manifestSchema.safeParse(v5()).success).toBe(false);
    expect((publishedManifestSchema.parse(v5()) as ManifestV5).surfaces).toHaveLength(2);
  });

  it('transports v5 samples in manifest surface order with per-value ownership', () => {
    const manifest = v5(), response = sampleResponseV5();
    expect(sampleResponseV5Schema.parse(parseBoundedJson(encodeBoundedJson(response, MAX_MANIFEST_BYTES)))).toEqual(response);
    expect(response.surfaces).toEqual(manifest.surfaces.map(({ id, kind, layers, coverage }) => ({ id, kind, layers, coverage })));
    expect(publishedSampleResponseSchema.safeParse(response).success).toBe(true);
    const legacy = sampleResponseSchema.parse({
      model: manifest.model, buildId: manifest.buildId, lat: 52.5, lon: 13.4,
      method: manifest.method, source: manifest.source, coverage: manifest.surfaces[0].coverage, expiresAt: manifest.expiresAt,
      frames: manifest.frames.map(frame => ({ ...frame, layers: { 'precip-rate': { value: 1, status: 'valid', support: 1, interpolated: false } } }))
    });
    expect(publishedSampleResponseSchema.safeParse(legacy).success).toBe(true);
    expect(sampleResponseV5Schema.safeParse(legacy).success).toBe(false);
  });

  it.each(['singular-coverage', 'patch-id', 'missing-surface-id', 'wrong-owner', 'duplicate-surface', 'surface-grid'] as const)('rejects strict malformed v5 sample transport: %s', defect => {
    const response = sampleResponseV5(), native = response.surfaces[0], fine = response.surfaces[1];
    const layer = native.layers[0], value = response.frames[0].layers[layer];
    if (defect === 'singular-coverage') (response as Record<string, unknown>).coverage = native.coverage;
    if (defect === 'patch-id') response.frames[0].layers[layer] = { ...value, patchId: 'zone-001' } as typeof value;
    if (defect === 'missing-surface-id') { const without = { ...value }; delete (without as { surfaceId?: string }).surfaceId; response.frames[0].layers[layer] = without as typeof value; }
    if (defect === 'wrong-owner') response.frames[0].layers[layer] = { ...value, surfaceId: fine.id };
    if (defect === 'duplicate-surface') response.surfaces = [native, { ...fine, id: native.id }];
    if (defect === 'surface-grid') response.surfaces = [{ ...native, grid: v5().surfaces[0].grid } as unknown as typeof native, fine];
    expect(sampleResponseV5Schema.safeParse(response).success).toBe(false);
  });
});

describe('v2 terrain references', () => {
  it('accepts canonical content keys independent of the manifest digest', () => {
    const manifest = v5(), terrain = manifest.surfaces[1].terrain!;
    expect(terrain.key).toMatch(/^terrain\/prepared\/[a-f0-9]{64}\/manifest\.json$/);
    expect(terrain.key).not.toBe(`terrain/prepared/${terrain.sha256}/manifest.json`);
    expect(manifestV5Schema.safeParse(manifest).success).toBe(true);
    expect(() => validateArtifactRecordsV5(manifest)).not.toThrow();
  });

  it.each(['wrong-prefix', 'wrong-filename', 'uppercase-hash', 'short-hash'] as const)('rejects a non-canonical terrain key: %s', defect => {
    const manifest = v5(), terrain = manifest.surfaces[1].terrain!;
    if (defect === 'wrong-prefix') terrain.key = terrain.key.replace('terrain/prepared/', 'builds/prepared/');
    if (defect === 'wrong-filename') terrain.key = terrain.key.replace('/manifest.json', '/descriptor.json');
    if (defect === 'uppercase-hash') terrain.key = terrain.key.replace(/[a-f0-9]{64}/, 'A'.repeat(64));
    if (defect === 'short-hash') terrain.key = terrain.key.replace(/[a-f0-9]{64}/, 'a'.repeat(63));
    expect(manifestV5Schema.safeParse(manifest).success).toBe(false);
  });

  it.each(['grid-hash', 'coverage-hash', 'layout-version', 'native-terrain'] as const)('rejects terrain identity mismatch: %s', defect => {
    const manifest = v5(), fine = manifest.surfaces[1], terrain = fine.terrain!;
    if (defect === 'grid-hash') terrain.gridHash = 'e'.repeat(64);
    if (defect === 'coverage-hash') terrain.coverageHash = 'e'.repeat(64);
    if (defect === 'layout-version') (terrain as { layoutVersion: number }).layoutVersion = 2;
    if (defect === 'native-terrain') manifest.surfaces[0].terrain = structuredClone(terrain);
    expect(manifestV5Schema.safeParse(manifest).success).toBe(false);
  });
});


it('binds native profile groups to the scalar coverage block geometry and codec width', () => {
  const manifest = v5(), surface = manifest.surfaces[0], recordBytes = PROFILE_HEADER_BYTES + 3 * PROFILE_LEVEL_BYTES;
  const frames = manifest.frames.length, prefix = `builds/${manifest.model}/${manifest.buildId}/surfaces/native/profiles`;
  surface.profiles = { format: PROFILE_PACK_FORMAT, blockSize: 16, levelCount: 3, recordBytes,
    coverageHash: surface.coverage.hash, blockCount: surface.samples.blockCount, storedCells: surface.samples.storedCells,
    groups: [{ firstFrame: 0, frameCount: frames, shards: surface.samples.shards.map((shard, index) => ({ ...shard,
      bytes: shard.storedCells * frames * recordBytes, key: `${prefix}/g0-b${index}.bin` })) }] };
  const binding = { grid: surface.grid, gridHash: surface.gridHash, coverageHash: surface.coverage.hash, blockIds: [0, 2, 3] };
  expect(() => manifestV5Schema.parse(manifest)).not.toThrow();
  expect(() => assertProfileLayoutBindingV5(surface, binding)).not.toThrow();
  expect(forecastObjectsV5(manifest).filter(object => object.key.includes('/profiles/'))).toHaveLength(2);
  expect(() => assertProfileLayoutBindingV5(surface, { ...binding, blockIds: [0, 1, 3] })).toThrow('size mismatch');
  expect(() => assertProfileLayoutBindingV5(surface, { ...binding, coverageHash: 'f'.repeat(64) })).toThrow('identity mismatch');
  for (const mutate of [
    (profiles: NonNullable<typeof surface.profiles>) => { profiles.recordBytes++; },
    (profiles: NonNullable<typeof surface.profiles>) => { profiles.groups[0].firstFrame++; },
    (profiles: NonNullable<typeof surface.profiles>) => { profiles.groups[0].shards[1].key = profiles.groups[0].shards[0].key; },
    (profiles: NonNullable<typeof surface.profiles>) => { profiles.groups[0].shards[1].storedCells++; },
    (profiles: NonNullable<typeof surface.profiles>) => { profiles.coverageHash = 'f'.repeat(64); }
  ]) {
    const changed = structuredClone(manifest);
    mutate(changed.surfaces[0].profiles!);
    expect(manifestV5Schema.safeParse(changed).success).toBe(false);
  }
  expect(() => assertProfileLayoutBindingV5(manifest.surfaces[1], binding)).toThrow('identity mismatch');
});
