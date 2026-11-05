import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CELL_BYTES,
  LAYER_IDS,
  gridSchema,
  manifestSchema,
  refinementPatchSchema,
  setBit,
  STATUS_NO_LIFT,
  STATUS_VALID,
  SUPPORT_PARCEL_CROSSING,
  SUPPORT_PROFILE_TOP,
  validateArtifactRecords,
  type CoverageMask
} from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { fixtureManifest } from '../../../../tests/forecast-fixture.js';
import { writeCoverage } from '../coverage.js';
import { encodeJson, sha256, TERRAIN_SOURCE } from '../terrain/contract.js';
import { PREPARED_DESCRIPTOR_MAX_BYTES, PREPARED_TERRAIN_METHOD } from '../terrain/prepare.js';
import { fileSha256 } from '../validate.js';
import {
  MAX_EVALUATION_FILE_BYTES,
  decodeSamplePack,
  evaluationPath,
  frameHour,
  linearPercentile,
  loadEvaluationInput,
  normalizeSourceEvidence,
  sameSourceEvidence,
  selectSourceFrames,
  summarizePairedFields
} from './evaluation-input.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const baseGrid = {
  kind: 'regular-latlon' as const, width: 3, height: 3, earthRadiusM: 6371229,
  lon0: 0, lat0: 1, dx: 0.01, dy: -0.01, wrapLongitude: false
};
const baseBounds: [number, number, number, number] = [0, 0.98, 0.02, 1];
const patchGrid = {
  kind: 'lambert-conformal' as const, width: 3, height: 3, earthRadiusM: 6371229,
  centralMeridianDeg: 1, latitudeOfOriginDeg: 0.99, standardParallel1Deg: 0.99,
  standardParallel2Deg: 0.99, x0M: -1000, y0M: 1000, dxM: 1000, dyM: -1000, wrapLongitude: false as const
};
const patchBounds: [number, number, number, number] = [0.0001, 0.9801, 0.0199, 0.9999];
const cycle = '2026-10-30T00:00:00.000Z';
const buildId = '20261030T000000Z-evaluation-fixture';

function mask(grid: CoverageMask['grid'], bounds: [number, number, number, number]): CoverageMask {
  const output = new Uint8Array(Math.ceil(grid.width * grid.height / 8)), halo = new Uint8Array(output.length);
  for (let index = 0; index < grid.width * grid.height; index++) setBit(output, index);
  return { grid, bounds, output, halo, tiles: Uint8Array.of(1), maxZoom: 0 };
}

async function write(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

function packBytes(maskValue: CoverageMask, channelCount: number): Buffer {
  const layout = prepareSamplePackLayout(maskValue.grid, maskValue.output, maskValue.halo), bytes = Buffer.alloc(layout.storedCells * channelCount * CELL_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let cell = 0; cell < layout.storedCells; cell++) for (let channel = 0; channel < channelCount; channel++) {
    const offset = (cell * channelCount + channel) * CELL_BYTES;
    view.setFloat32(offset, cell * 100 + channel, true);
    view.setUint8(offset + 4, STATUS_VALID | SUPPORT_PARCEL_CROSSING);
  }
  return bytes;
}

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-evaluation-input-')); roots.push(out);
  const buildDir = join(out, 'builds', 'gfs', buildId), manifestPath = join(buildDir, 'manifest.json');
  const sourceMask = mask(baseGrid, baseBounds), targetMask = mask(patchGrid, patchBounds);
  const sourceHash = await writeCoverage(out, sourceMask, { coverageId: 'source', coverageDescription: 'source', bounds: baseBounds, supportHaloCells: 1 });
  const targetHash = await writeCoverage(out, targetMask, { coverageId: 'target', coverageDescription: 'target', bounds: patchBounds, supportHaloCells: 1 });
  const sourceCoverage = { id: 'source', hash: sourceHash, maskKey: `coverage/${sourceHash}/manifest.json`, maxZoom: 0 };
  const targetCoverage = { id: 'target', hash: targetHash, maskKey: `coverage/${targetHash}/manifest.json`, maxZoom: 0 };

  const dataId = 'd'.repeat(64);
  const terrainIdentity = sha256(encodeJson({ dataId, grid: gridSchema.parse(patchGrid), method: PREPARED_TERRAIN_METHOD }, PREPARED_DESCRIPTOR_MAX_BYTES));
  const terrainPrefix = `terrain/prepared/${terrainIdentity}`;
  const elevation = Buffer.alloc(patchGrid.width * patchGrid.height * 4), valid = Buffer.alloc(patchGrid.width * patchGrid.height, 1);
  for (let index = 0; index < patchGrid.width * patchGrid.height; index++) elevation.writeFloatLE(100 + index, index * 4);
  const elevationSha = sha256(elevation), validSha = sha256(valid);
  await write(join(out, `${terrainPrefix}/elevation.f32`), elevation);
  await write(join(out, `${terrainPrefix}/valid.u8`), valid);
  const terrainDescriptor = encodeJson({
    version: 1, dataId, method: PREPARED_TERRAIN_METHOD, grid: patchGrid, source: TERRAIN_SOURCE,
    files: {
      elevationM: { key: `${terrainPrefix}/elevation.f32`, sha256: elevationSha, bytes: elevation.byteLength },
      valid: { key: `${terrainPrefix}/valid.u8`, sha256: validSha, bytes: valid.byteLength }
    }
  }, PREPARED_DESCRIPTOR_MAX_BYTES);
  const terrainDescriptorSha = sha256(terrainDescriptor);
  await write(join(out, `${terrainPrefix}/manifest.json`), terrainDescriptor);

  const frames = [
    { id: 'f001', validTime: '2026-10-30T01:00:00.000Z', intervalStart: '2026-10-30T00:00:00.000Z', intervalEnd: '2026-10-30T01:00:00.000Z' },
    { id: 'f002', validTime: '2026-10-30T02:00:00.000Z', intervalStart: '2026-10-30T01:00:00.000Z', intervalEnd: '2026-10-30T02:00:00.000Z' }
  ];
  const layers = ['usable-lift-msl', 'usable-lift-agl'] as const;
  const base = fixtureManifest(), baseMethodId = base.descriptors.layers['usable-lift-msl'].methodId;
  const patchLayers = Object.fromEntries(layers.map(layer => [layer, {
    ...base.descriptors.layers[layer], methodId: 'fixture-terrain-column',
    ...(layer === 'usable-lift-agl' ? { label: 'Usable lift depth (terrain AGL)', verticalReference: 'terrain-AGL' as const } : {})
  }]));
  const patchMethod = { ...base.descriptors.methods[baseMethodId], id: 'fixture-terrain-column', outputs: [...layers] };
  const patch = refinementPatchSchema.parse({
    id: 'zone-001', grid: patchGrid, coverage: targetCoverage,
    geometry: { type: 'Polygon', coordinates: [[[0.0001, 0.9801], [0.0199, 0.9801], [0.0199, 0.9999], [0.0001, 0.9999], [0.0001, 0.9801]]] },
    descriptors: { ...base.descriptors, bounds: patchBounds, layers: patchLayers, methods: { 'fixture-terrain-column': patchMethod }, palettes: base.descriptors.palettes.filter(palette => palette.id === 'lift') },
    layers: [...layers], method: { id: 'fixture-terrain-column', hash: base.method.hash },
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: 9, channelCount: 4, bytes: 9 * 4 * CELL_BYTES,
      key: `builds/gfs/${buildId}/refinements/zone-001/samples.bin`, sha256: '0'.repeat(64) },
    terrain: { dataId, key: `${terrainPrefix}/manifest.json`, sha256: terrainDescriptorSha, verticalDatum: 'EGM2008', surface: 'DSM' }
  });
  const baseLayout = prepareSamplePackLayout(baseGrid, sourceMask.output, sourceMask.halo);
  const basePack = packBytes(sourceMask, frames.length * layers.length), patchPack = packBytes(targetMask, frames.length * layers.length);
  patch.samples = { ...patch.samples, storedCells: prepareSamplePackLayout(patchGrid, targetMask.output, targetMask.halo).storedCells,
    channelCount: frames.length * layers.length, bytes: patchPack.byteLength, sha256: sha256(patchPack) };
  const prefix = `builds/gfs/${buildId}`;
  await write(join(out, `${prefix}/samples.bin`), basePack);
  await write(join(out, `${prefix}/refinements/zone-001/samples.bin`), patchPack);
  const artifacts = frames.flatMap(frame => layers.map(layer => {
    const bytes = Buffer.from(`${frame.id}/${layer}`), tilesKey = `${prefix}/${layer}/${frame.id}.pmtiles`;
    return { layer, frame: frame.id, tilesKey, tilesSha256: sha256(bytes), bytes };
  }));
  for (const artifact of artifacts) await write(join(out, artifact.tilesKey), artifact.bytes);

  const provenance = {
    version: 1, model: 'gfs', buildId, cycle, provider: 'NOAA',
    frames: frames.map((frame, index) => ({
      hour: index + 1,
      intervals: { profileTime: frame.validTime, fluxWindow: { start: frame.intervalStart, end: frame.intervalEnd },
        fluxSourceWindow: { start: frame.intervalStart, end: frame.intervalEnd }, usedCompanion: false },
      receipt: { schemaVersion: 1, hour: index + 1, capturedAt: '2026-10-30T00:00:01.000Z',
        objects: [{ field: 'TMP', hour: index + 1, level: 1000, sha256: String(index + 1).repeat(64), cacheHit: true }] }
    }))
  };
  const provenanceBytes = encodeJson(provenance), provenanceSha = sha256(provenanceBytes);
  await write(join(out, `${prefix}/provenance.json`), provenanceBytes);

  const manifest = manifestSchema.parse({
    ...base, version: 4, buildId, cycle, grid: baseGrid, coverage: sourceCoverage, bounds: baseBounds,
    descriptors: { ...base.descriptors, bounds: baseBounds,
      layers: Object.fromEntries(layers.map(layer => [layer, base.descriptors.layers[layer]])),
      methods: { [baseMethodId]: base.descriptors.methods[baseMethodId] },
      palettes: base.descriptors.palettes.filter(palette => palette.id === 'lift') },
    method: { ...base.method, id: baseMethodId },
    frames, layers: [...layers], artifacts: artifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: baseLayout.storedCells,
      channelCount: frames.length * layers.length, bytes: basePack.byteLength, sha256: sha256(basePack), key: `${prefix}/samples.bin` },
    patches: [patch],
    source: { provider: 'NOAA', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: provenanceSha, model: 'gfs' }
  });
  validateArtifactRecords(manifest);
  await write(manifestPath, JSON.stringify(manifest));
  return { out, manifestPath, manifest, sourceMask, targetMask, basePack, patchPack, provenance, prefix };
}

describe('evaluation input admission', () => {
  it('rejects oversized archives before hashing and bounds streamed hash work', async () => {
    const values = await fixture(), artifact = values.manifest.artifacts[0]!;
    const path = join(values.out, artifact.tilesKey);
    await truncate(path, MAX_EVALUATION_FILE_BYTES + 1);
    await expect(loadEvaluationInput({ manifestPath: values.manifestPath })).rejects.toThrow('byte budget');
    await writeFile(path, Buffer.alloc(128, 1));
    await expect(fileSha256(path, 127)).rejects.toThrow('byte budget');
    expect(await fileSha256(path, 128)).toBe(sha256(Buffer.alloc(128, 1)));
    await expect(fileSha256(path, -1)).rejects.toThrow('budget');
  });

  it('rejects sparse packs whose expanded field buffers exceed the admission budget', () => {
    const large: CoverageMask = { grid: { ...baseGrid, width: 2000, height: 2000 },
      output: new Uint8Array(500000), halo: new Uint8Array(500000), tiles: Uint8Array.of(1), maxZoom: 0 };
    const frames = Array.from({ length: 32 }, (_, i) => `f${i}`);
    expect(() => decodeSamplePack(new Uint8Array(1), large, frames, ['usable-lift-msl'], frames.length)).toThrow('Decoded evaluation byte budget');
  });

  it('loads a verified control build, masks, terrain, frames and stored pack', async () => {
    const values = await fixture();
    const control = await loadEvaluationInput({ manifestPath: values.manifestPath });
    expect(control.outputRoot).toBe(values.out);
    expect(control.manifestSha256).toBe(sha256(await readFile(values.manifestPath)));
    expect(control.sourceMask.output.byteLength).toBe(2);
    expect([...control.terrain.elevationM.slice(0, 3)]).toEqual([100, 101, 102]);
    expect([...control.terrain.valid]).toEqual(new Array(9).fill(1));
    expect(control.terrainRef.sha256).toBe(control.patch.terrain.sha256);
    expect(frameHour(control.manifest, control.manifest.frames[1]!)).toBe(2);
    const selected = selectSourceFrames(control, ['f002']);
    expect(selected).toHaveLength(1);
    expect(selected[0]).toMatchObject({ frameId: 'f002', hour: 2 });

    const decoded = decodeSamplePack(values.patchPack, control.targetMask, ['f001', 'f002'], ['usable-lift-msl', 'usable-lift-agl'], 4);
    expect(decoded.fields.f002!['usable-lift-agl']!.values[8]).toBe(8 * 100 + 3);
    expect(decoded.fields.f002!['usable-lift-agl']!.flags[8]).toBe(STATUS_VALID | SUPPORT_PARCEL_CROSSING);

    const v5Path = join(values.out, 'v5-manifest.json');
    await writeFile(v5Path, JSON.stringify({ ...values.manifest, version: 5 }));
    await expect(loadEvaluationInput({ manifestPath: v5Path })).rejects.toThrow('Control manifest must be a v4 regional-patch build');
  });

  it('rejects path traversal and absent or mismatched stored sources', async () => {
    expect(() => evaluationPath('/tmp/evaluation-root', '../outside.bin')).toThrow('Invalid artifact key');
    expect(() => evaluationPath('/tmp/evaluation-root', '/etc/passwd')).toThrow('Invalid artifact key');

    const absent = await fixture();
    await rm(join(absent.out, `${absent.prefix}/samples.bin`));
    await expect(loadEvaluationInput({ manifestPath: absent.manifestPath })).rejects.toThrow();

    const corrupt = await fixture();
    const artifact = corrupt.manifest.artifacts[0]!;
    await write(join(corrupt.out, artifact.tilesKey), 'changed');
    await expect(loadEvaluationInput({ manifestPath: corrupt.manifestPath })).rejects.toThrow('hash mismatch');
  });

  it('rejects a raw-source interval mismatch', async () => {
    const values = await fixture();
    const control = await loadEvaluationInput({ manifestPath: values.manifestPath });
    const frame = control.provenance.frames[0]!;
    (frame.intervals as { fluxWindow: { end: string } }).fluxWindow.end = '2026-10-30T02:00:00.000Z';
    expect(() => selectSourceFrames(control, ['f001'])).toThrow('interval mismatch');
  });

  it('normalizes only capture bookkeeping while preserving object hashes', async () => {
    const values = await fixture();
    const control = await loadEvaluationInput({ manifestPath: values.manifestPath });
    const expected = selectSourceFrames(control, ['f001'])[0]!;
    const actual = structuredClone(expected);
    (actual.receipt as { capturedAt: string }).capturedAt = '2026-10-30T09:00:00.000Z';
    (actual.receipt as { objects: { cacheHit: boolean }[] }).objects[0]!.cacheHit = false;
    expect(sameSourceEvidence(expected, actual)).toBe(true);
    expect(normalizeSourceEvidence(expected.receipt)).not.toHaveProperty('capturedAt');
    (actual.receipt as { objects: { sha256: string }[] }).objects[0]!.sha256 = 'f'.repeat(64);
    expect(sameSourceEvidence(expected, actual)).toBe(false);

    const receipt = expected.receipt as { objects: Record<string, unknown>[] } & Record<string, unknown>;
    const reordered = {
      ...Object.fromEntries(Object.entries(receipt).filter(([key]) => key !== 'objects').reverse()),
      objects: receipt.objects.map(object => Object.fromEntries(Object.entries(object).reverse()))
    };
    expect(sameSourceEvidence(expected, { intervals: expected.intervals, receipt: reordered })).toBe(true);
    const firstObject = reordered.objects[0]!, secondObject = { ...firstObject, level: 850 };
    expect(sameSourceEvidence(
      { intervals: expected.intervals, receipt: { ...reordered, objects: [firstObject, secondObject] } },
      { intervals: expected.intervals, receipt: { ...reordered, objects: [secondObject, firstObject] } }
    )).toBe(false);
    expect(sameSourceEvidence(expected, { intervals: expected.intervals, receipt: { ...reordered, validAt: '2026-10-30T09:00:00.000Z' } })).toBe(false);
  });
});

describe('evaluation summaries', () => {
  it('computes linear percentiles and null statistics for an empty common-valid population', () => {
    expect(linearPercentile([], 0.5)).toBeNull();
    expect(linearPercentile([0, 10], 0.5)).toBe(5);
    expect(linearPercentile([0, 10, 20], 0.95)).toBeCloseTo(19, 12);
    expect(() => linearPercentile([10, 0], 0.5)).toThrow('sorted');

    const left = { values: Float32Array.of(1, 2, NaN, 4), flags: Uint8Array.of(STATUS_VALID, STATUS_NO_LIFT, STATUS_VALID, STATUS_VALID | SUPPORT_PROFILE_TOP) };
    const right = { values: Float32Array.of(1, 9, 8, 7), flags: Uint8Array.of(STATUS_VALID, STATUS_NO_LIFT, STATUS_NO_LIFT, STATUS_VALID) };
    const summary = summarizePairedFields(left, right);
    expect(summary.commonValidCells).toBe(2);
    expect(summary.medianAbsoluteDifference).toBe(1.5);
    expect(summary.statusTransitions).toEqual([
      { from: STATUS_VALID, to: STATUS_VALID, count: 2 },
      { from: STATUS_VALID, to: STATUS_NO_LIFT, count: 1 },
      { from: STATUS_NO_LIFT, to: STATUS_NO_LIFT, count: 1 }
    ]);
    expect(summary.supportTransitions).toContainEqual({ from: SUPPORT_PROFILE_TOP, to: 0, count: 1 });

    const empty = summarizePairedFields(
      { values: Float32Array.of(NaN), flags: Uint8Array.of(STATUS_NO_LIFT) },
      { values: Float32Array.of(1), flags: Uint8Array.of(STATUS_VALID) }
    );
    expect(empty).toMatchObject({ totalCells: 1, commonValidCells: 0, medianAbsoluteDifference: null, p95AbsoluteDifference: null, maximumAbsoluteDifference: null });
  });

  it('rejects decoded packs with mismatched channel or byte identity', async () => {
    const values = await fixture();
    const control = await loadEvaluationInput({ manifestPath: values.manifestPath });
    expect(() => decodeSamplePack(values.patchPack.subarray(1), control.targetMask, ['f001', 'f002'], ['usable-lift-msl', 'usable-lift-agl'], 4)).toThrow('byte length');
    expect(() => decodeSamplePack(values.patchPack, control.targetMask, ['f001'], ['usable-lift-msl', 'usable-lift-agl'], 4)).toThrow('identity mismatch');
    expect(LAYER_IDS).toContain('usable-lift-agl');
  });
});
