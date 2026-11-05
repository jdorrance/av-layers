import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../../tests/model-fixtures.js';
import { indexedSource } from '../indexed-grib/source.js';
import { splitSource } from '../split-grib/source.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CELL_BYTES,
  gridSchema,
  manifestSchema,
  refinementPatchSchema,
  setBit,
  STATUS_OUTSIDE,
  STATUS_UNAVAILABLE,
  STATUS_VALID,
  TERRAIN_CLEARANCE_METHOD,
  validateSampleFlags,
  validateArtifactRecords,
  type CoverageMask
} from '@av/contracts';
import { prepareSamplePackLayout, type NormalizedFrame } from '@av/forecast';
import { fixtureManifest } from '../../../../tests/forecast-fixture.js';
import type { ForecastProvider, ForecastSession } from '../provider.js';
import { writeCoverage } from '../coverage.js';
import { createSamplePackBuilder } from '../sample-pack.js';
import { encodeJson, sha256, TERRAIN_SOURCE } from '../terrain/contract.js';
import { PREPARED_DESCRIPTOR_MAX_BYTES, PREPARED_TERRAIN_METHOD } from '../terrain/prepare.js';
import { createSplitGribAcquisitionSession } from '../split-grib/acquire.js';
import { splitGribRegularFieldUrl } from '../split-grib/fields.js';
import { createIndexedGribAcquisitionSession } from '../indexed-grib/acquire.js';
import { decodeSamplePack } from './evaluation-input.js';
import { runEvaluation, runEvaluationCli, sampleNativeTargetFields } from './evaluate.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

const buildId = '20261030T000000Z-e4de530b-0527-4e42-aaf2-e5b124cb77e7';
const cycle = '2026-10-30T00:00:00.000Z';
const sourceGrid = {
  kind: 'regular-latlon' as const, width: 3, height: 3, earthRadiusM: 6371229,
  lon0: 44.18, lat0: 40.53, dx: 0.01, dy: -0.01, wrapLongitude: false
};
const sourceBounds: [number, number, number, number] = [44.17, 40.51, 44.20, 40.54];
const patchGrid = {
  kind: 'lambert-conformal' as const, width: 3, height: 3, earthRadiusM: 6371229,
  centralMeridianDeg: 44.19, latitudeOfOriginDeg: 40.52, standardParallel1Deg: 40.52,
  standardParallel2Deg: 40.52, x0M: -1000, y0M: 1000, dxM: 1000, dyM: -1000, wrapLongitude: false as const
};
const patchBounds: [number, number, number, number] = [44.17, 40.51, 44.20, 40.54];
const frameId = 'f009';
const validTime = '2026-10-30T09:00:00.000Z';
const intervalStart = '2026-10-30T08:00:00.000Z';
const nextFrameId = 'f010';

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
    view.setFloat32(offset, channel === 0 ? 300 + cell * 400 : 100 + cell * 300, true);
    view.setUint8(offset + 4, STATUS_VALID);
  }
  return bytes;
}

function clearancePackBytes(
  maskValue: CoverageMask,
  frameCount: number,
  elevationM: readonly number[],
  depthM: readonly (number | null)[]
): Buffer {
  const layers = ['usable-lift-msl', 'usable-lift-agl'] as const, channelCount = frameCount * layers.length;
  const layout = prepareSamplePackLayout(maskValue.grid, maskValue.output, maskValue.halo), bytes = Buffer.alloc(layout.storedCells * channelCount * CELL_BYTES);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let frame = 0; frame < frameCount; frame++) for (let layer = 0; layer < layers.length; layer++) for (let cell = 0; cell < layout.storedCells; cell++) {
    const offset = (cell * channelCount + frame * layers.length + layer) * CELL_BYTES;
    const value = depthM[frame] === null ? Number.NaN : layers[layer] === 'usable-lift-msl'
      ? Math.fround(elevationM[cell]! + depthM[frame]!) : depthM[frame]!;
    view.setFloat32(offset, value, true);
    view.setUint8(offset + 4, depthM[frame] === null ? STATUS_UNAVAILABLE : STATUS_VALID);
  }
  return bytes;
}

function normalizedFrame(hour = 9): NormalizedFrame {
  const values = (value: number) => new Float32Array(9).fill(value), missing = () => new Uint8Array(9);
  const frameValidAt = new Date(Date.parse(cycle) + hour * 3_600_000).toISOString();
  const frameIntervalStart = new Date(Date.parse(cycle) + (hour - 1) * 3_600_000).toISOString();
  const intervals = {
    profileTime: frameValidAt,
    fluxWindow: { start: frameIntervalStart, end: frameValidAt },
    fluxSourceWindow: { start: frameIntervalStart, end: frameValidAt },
    usedCompanion: false
  };
  return {
    cycle, hour, validAt: frameValidAt, capturedAt: '2026-10-30T08:10:00.000Z', grid: sourceGrid,
    activeIndices: Uint32Array.from({ length: 9 }, (_, index) => index),
    terrainM: values(100), surfacePressurePa: values(90_000), temp2mK: values(285),
    specificHumidity2mKgKg: values(0.006), sensibleHeatFluxWm2: values(250), latentHeatFluxWm2: values(120),
    precipitationMmPerHour: values(0), pressureLevelsHpa: [850], hgtM: [values(1000)], tempK: [values(280)],
    missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(),
      sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing()], temp: [missing()] },
    intervals,
    receipt: { schemaVersion: 1, hour: 9, capturedAt: '2026-10-30T08:10:00.000Z',
      objects: [{ field: 'TMP', hour: 9, level: 850, sha256: 'a'.repeat(64), cacheHit: true }] }
  };
}

function provider(options: { failHour?: number; onOpen?: (value: { readOnlyCache?: boolean; offline?: boolean }) => void } = {}): ForecastProvider {
  return {
    id: 'fake', provider: 'NOAA', maxLevels: 2,
    async open(openOptions): Promise<ForecastSession> {
      options.onOpen?.(openOptions);
      return {
        cycle, stats: { acquired: 1 },
        async acquire(hour) {
          if (hour === options.failHour) throw new Error('Injected acquisition failure');
          return normalizedFrame(hour);
        },
        async close() {}
      };
    }
  };
}

interface FixtureOptions {
  readonly patchMethodId?: string;
  readonly terrainElevation?: (index: number) => number;
  readonly clearanceDepthM?: readonly (number | null)[];
}

async function fixture(options: FixtureOptions = {}) {
  const out = await mkdtemp(join(tmpdir(), 'av-evaluate-')); roots.push(out);
  const buildDir = join(out, 'builds', 'gfs', buildId), manifestPath = join(buildDir, 'manifest.json');
  const sourceMask = mask(sourceGrid, sourceBounds), targetMask = mask(patchGrid, patchBounds);
  const sourceHash = await writeCoverage(out, sourceMask, { coverageId: 'source', coverageDescription: 'source', bounds: sourceBounds, supportHaloCells: 1 });
  const targetHash = await writeCoverage(out, targetMask, { coverageId: 'target', coverageDescription: 'target', bounds: patchBounds, supportHaloCells: 1 });

  const dataId = 'd'.repeat(64);
  const terrainIdentity = sha256(encodeJson({ dataId, grid: gridSchema.parse(patchGrid), method: PREPARED_TERRAIN_METHOD }, PREPARED_DESCRIPTOR_MAX_BYTES));
  const terrainPrefix = `terrain/prepared/${terrainIdentity}`;
  const elevation = Buffer.alloc(9 * 4), valid = Buffer.alloc(9, 1);
  const terrainElevation = Array.from({ length: 9 }, (_, index) => (options.terrainElevation ?? (value => 1000 + value * 20))(index));
  for (let index = 0; index < 9; index++) elevation.writeFloatLE(terrainElevation[index]!, index * 4);
  await write(join(out, `${terrainPrefix}/elevation.f32`), elevation);
  await write(join(out, `${terrainPrefix}/valid.u8`), valid);
  const descriptor = encodeJson({
    version: 1, dataId, method: PREPARED_TERRAIN_METHOD, grid: patchGrid, source: TERRAIN_SOURCE,
    files: {
      elevationM: { key: `${terrainPrefix}/elevation.f32`, sha256: sha256(elevation), bytes: elevation.byteLength },
      valid: { key: `${terrainPrefix}/valid.u8`, sha256: sha256(valid), bytes: valid.byteLength }
    }
  }, PREPARED_DESCRIPTOR_MAX_BYTES);
  await write(join(out, `${terrainPrefix}/manifest.json`), descriptor);

  const frames = [
    { id: frameId, validTime, intervalStart, intervalEnd: validTime },
    { id: nextFrameId, validTime: '2026-10-30T10:00:00.000Z', intervalStart: validTime, intervalEnd: '2026-10-30T10:00:00.000Z' }
  ];
  const layers = ['usable-lift-msl', 'usable-lift-agl'] as const;
  const base = fixtureManifest(), methodId = base.descriptors.layers['usable-lift-msl'].methodId;
  const patchMethodId = options.patchMethodId ?? TERRAIN_CLEARANCE_METHOD.id;
  const patchLayers = Object.fromEntries(layers.map(layer => [layer, {
    ...base.descriptors.layers[layer], methodId: patchMethodId,
    ...(layer === 'usable-lift-agl' ? { label: 'Usable lift depth (terrain AGL)', verticalReference: 'terrain-AGL' as const } : {})
  }]));
  const patchMethod = { ...base.descriptors.methods[methodId], id: patchMethodId, outputs: [...layers] };
  const basePack = packBytes(sourceMask, frames.length * layers.length);
  const patchPack = options.clearanceDepthM
    ? clearancePackBytes(targetMask, frames.length, terrainElevation, options.clearanceDepthM)
    : packBytes(targetMask, frames.length * layers.length);
  const patch = refinementPatchSchema.parse({
    id: 'zone-001', grid: patchGrid,
    coverage: { id: 'target', hash: targetHash, maskKey: `coverage/${targetHash}/manifest.json`, maxZoom: 0 },
    geometry: { type: 'Polygon', coordinates: [[[44.17, 40.51], [44.20, 40.51], [44.20, 40.54], [44.17, 40.54], [44.17, 40.51]]] },
    descriptors: { ...base.descriptors, bounds: patchBounds, layers: patchLayers,
      methods: { [patchMethodId]: patchMethod },
      palettes: base.descriptors.palettes.filter(palette => palette.id === 'lift') },
    layers: [...layers], method: { id: patchMethodId, hash: base.method.hash },
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: prepareSamplePackLayout(patchGrid, targetMask.output, targetMask.halo).storedCells,
      channelCount: frames.length * layers.length, bytes: patchPack.byteLength, sha256: sha256(patchPack), key: `builds/gfs/${buildId}/refinements/zone-001/samples.bin` },
    terrain: { dataId, key: `${terrainPrefix}/manifest.json`, sha256: sha256(descriptor), verticalDatum: 'EGM2008', surface: 'DSM' }
  });
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
    frames: [
      { hour: 9, intervals: normalizedFrame(9).intervals, receipt: normalizedFrame(9).receipt },
      { hour: 10, intervals: normalizedFrame(10).intervals, receipt: normalizedFrame(10).receipt }
    ]
  };
  const provenanceBytes = encodeJson(provenance);
  await write(join(out, `${prefix}/provenance.json`), provenanceBytes);
  const manifest = manifestSchema.parse({
    ...base, version: 4, buildId, cycle, grid: sourceGrid,
    coverage: { id: 'source', hash: sourceHash, maskKey: `coverage/${sourceHash}/manifest.json`, maxZoom: 0 },
    descriptors: { ...base.descriptors, bounds: sourceBounds,
      layers: Object.fromEntries(layers.map(layer => [layer, base.descriptors.layers[layer]])),
      methods: { [methodId]: base.descriptors.methods[methodId] },
      palettes: base.descriptors.palettes.filter(palette => palette.id === 'lift') },
    method: { ...base.method, id: methodId },
    frames, layers: [...layers], artifacts: artifacts.map(({ bytes: _bytes, ...artifact }) => artifact),
    samples: { format: 'cell-major-blocks-v1', blockSize: 16, storedCells: prepareSamplePackLayout(sourceGrid, sourceMask.output, sourceMask.halo).storedCells,
      channelCount: frames.length * layers.length, bytes: basePack.byteLength, sha256: sha256(basePack), key: `${prefix}/samples.bin` },
    patches: [patch],
    source: { provider: 'NOAA', provenanceKey: `${prefix}/provenance.json`, provenanceSha256: sha256(provenanceBytes), model: 'gfs' }
  });
  validateArtifactRecords(manifest);
  await write(manifestPath, JSON.stringify(manifest));
  return { out, manifestPath, packageOut: join(out, 'evaluation') };
}

describe('paired evaluation CLI orchestration', () => {
  it('rejects a nonlegacy control patch before acquisition or publication', async () => {
    const values = await fixture({ patchMethodId: 'other-refinement-v1' });
    let opened = false;
    await expect(runEvaluation({
      controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut,
      frames: [frameId], provider: provider({ onOpen: () => { opened = true; } })
    })).rejects.toThrow('clearance');
    expect(opened).toBe(false);
    await expect(readFile(join(values.packageOut, buildId, 'report.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs every variant, writes compact deterministic evidence, field packs and matched images once', async () => {
    const values = await fixture();
    let opened: { readOnlyCache?: boolean; offline?: boolean } | undefined;
    const result = await runEvaluation({
      controlManifest: values.manifestPath,
      cacheDir: join(values.out, 'cache'),
      out: values.packageOut,
      frames: [frameId],
      provider: provider({ onOpen: options => { opened = options; } })
    });
    expect(result.deterministic.control.patch.method.id).toBe(TERRAIN_CLEARANCE_METHOD.id);
    expect(result.deterministic.control.patch.method.hash).toBe(fixtureManifest().method.hash);
    expect(result.deterministic.control.method.id).not.toBe(result.deterministic.control.patch.method.id);
    expect(opened).toMatchObject({ readOnlyCache: true, offline: true });
    expect(result.deterministic.variants.map(variant => variant.variant)).toEqual([
      'stored-clearance', 'native', 'candidate-neutral', 'candidate-supported-clearance'
    ]);
    const native = result.deterministic.variants.find(variant => variant.variant === 'native')!;
    const nativeSummary = native.comparisons.find(comparison => comparison.baseline === 'stored-clearance')!
      .populations['whole-zone']['usable-lift-msl'];
    expect(nativeSummary.statusHistogram.filter(row => row.status < 2).reduce((total, row) => total + row.left, 0)).toBeGreaterThanOrEqual(3);
    expect(result.report.path).toBe(join(values.packageOut, buildId, 'report.json'));
    const report = JSON.parse(await readFile(result.report.path, 'utf8'));
    expect(report.runtime).toMatchObject({
      elapsedMs: expect.any(Number), peakRssBytes: expect.any(Number),
      render: {
        step: { rasterMs: expect.any(Number), encodeMs: expect.any(Number), bytes: expect.any(Number) },
        smooth: { rasterMs: expect.any(Number), encodeMs: expect.any(Number), bytes: expect.any(Number) },
        bytesRatio: expect.any(Number)
      }
    });
    expect(result.runtime.render.bytesRatio).toBe(report.runtime.render.bytesRatio);
    expect(report.deterministic.candidate.sourceRevision).toMatch(/^[a-f0-9]{40}$/);
    expect(report.deterministic.candidate.sourceHashes.science).toMatch(/^[a-f0-9]{64}$/);
    expect(report.deterministic.scientificGate.status).toBe('inconclusive');
    expect(report.deterministic.probeTargets.map((probe: { name: string }) => probe.name)).toEqual(['Aragats', 'Yerevan', 'Aparan', 'Sevan']);
    let distinctTilePair = false;
    for (const variant of report.deterministic.variants) {
      for (const comparison of variant.comparisons) {
        const populations = Object.values(comparison.populations) as Record<string, {
          population: object; statusTransitions: unknown; supportTransitions: unknown
        }>[];
        for (const population of populations) {
          for (const summary of Object.values(population)) {
            expect(summary.population).not.toHaveProperty('indices');
            expect(Array.isArray(summary.statusTransitions)).toBe(true);
            expect(Array.isArray(summary.supportTransitions)).toBe(true);
          }
        }
      }
      expect(variant.fields.key).toContain(`${variant.variant}/${frameId}.bin`);
      const packedBytes = await readFile(join(values.packageOut, variant.fields.key));
      expect(packedBytes.byteLength).toBe(variant.fields.bytes);
      const packedView = new DataView(packedBytes.buffer, packedBytes.byteOffset, packedBytes.byteLength);
      for (let offset = 0; offset < packedBytes.byteLength; offset += CELL_BYTES) {
        const status = packedView.getUint8(offset + 4) & 3;
        if (status === STATUS_VALID || status < 2) expect(Number.isFinite(packedView.getFloat32(offset, true))).toBe(true);
      }
      if (variant.parameters) {
        const terminal = variant.metrics.dark! + variant.metrics.invalidDem! + variant.metrics.missingDonor!
          + variant.metrics.invalidDonorInput! + variant.metrics.unsupportedHeight! + variant.metrics.belowGroundBridgeExceeded!
          + variant.metrics.invalidSurfaceState! + variant.metrics.solverRejected! + variant.metrics.valid! + variant.metrics.noLift!;
        expect(terminal).toBe(9);
        expect(variant.metrics.filledBelowGroundBridgeExceeded).toEqual(expect.any(Number));
        expect(variant.metrics.column).toEqual(expect.any(Number));
        expect(variant.metrics.clearance).toEqual(expect.any(Number));
        for (const probe of variant.probes) {
          expect(Array.isArray(probe.donorIndices)).toBe(true);
          expect(Array.isArray(probe.donorWeights)).toBe(true);
          expect(Array.isArray(probe.donorGroundEnvironmentK)).toBe(true);
          expect(Array.isArray(probe.donorSurfaceExcessK)).toBe(true);
          expect(Array.isArray(probe.donorGroundWeights)).toBe(true);
          expect(probe).toHaveProperty('surfaceExcessK');
          expect(probe).toHaveProperty('maxBelowGroundDepthM');
          expect(probe).toHaveProperty('provenance');
          expect(probe).not.toHaveProperty('referenceEnvironmentK');
          expect(probe).not.toHaveProperty('rawBoostK');
          expect(probe).not.toHaveProperty('cappedBoostK');
          expect(probe).not.toHaveProperty('clearanceWeight');
          if (probe.surfaceExcessK !== null) {
            expect(probe.donorSurfaceExcessK).toHaveLength(probe.donorWeights.length);
            expect(probe.surfaceExcessK).toBeCloseTo(probe.donorWeights.reduce((sum: number, weight: number, i: number) => sum + weight * probe.donorSurfaceExcessK[i], 0), 10);
          }
          if (probe.groundEnvironmentK !== null) expect(probe.donorGroundWeights.reduce((sum: number, weight: number) => sum + weight, 0)).toBeCloseTo(1, 10);
        }
      }
      expect(variant.renderInvariance).toMatchObject({
        fieldSha256Identical: true, packSha256Identical: true,
        fieldSha256Before: variant.renderInvariance.fieldSha256After,
        packSha256Before: variant.renderInvariance.packSha256After
      });
      type ReportImage = {
        key: string; pairKey: string; style: 'step' | 'linear-rgb'; view: string;
        width: number; height: number; extent: unknown; sha256: string; bytes: number;
        valueUnits: string; fieldSha256: string; layer: string;
      };
      const pairs = new Map<string, { step: ReportImage; smooth: ReportImage }>();
      for (const image of variant.images as ReportImage[]) {
        expect(image.fieldSha256).toBe(variant.renderInvariance.fieldSha256Before);
        expect(image.valueUnits).toBe(image.layer === 'usable-lift-msl' ? 'm MSL' : 'm AGL');
        const existing = pairs.get(image.pairKey);
        const pair = existing ?? ({} as { step: ReportImage; smooth: ReportImage });
        pair[image.style === 'step' ? 'step' : 'smooth'] = image;
        pairs.set(image.pairKey, pair);
        expect((await readFile(join(values.packageOut, image.key))).byteLength).toBe(image.bytes);
      }
      expect(pairs.size).toBe(4);
      for (const pair of pairs.values()) {
        expect(pair.step.pairKey).toBe(pair.smooth.pairKey);
        expect(pair.step.extent).toEqual(pair.smooth.extent);
        expect(pair.step.width).toBe(pair.smooth.width);
        expect(pair.step.height).toBe(pair.smooth.height);
        expect(pair.step.key.endsWith('-step.webp')).toBe(true);
        expect(pair.smooth.key.endsWith('-smooth.webp')).toBe(true);
        expect(pair.step.style).toBe('step');
        expect(pair.smooth.style).toBe('linear-rgb');
        expect(pair.step.key.replace(/-step\.webp$/, '')).toBe(pair.smooth.key.replace(/-smooth\.webp$/, ''));
      }
      const tilePairs = [...pairs.values()].filter(pair => pair.step.view === 'aragats-z8-159-96');
      expect(tilePairs).toHaveLength(2);
      distinctTilePair ||= tilePairs.some(pair => pair.step.sha256 !== pair.smooth.sha256);
      const tile = (variant.images as ReportImage[]).find(image => image.view === 'aragats-z8-159-96' && image.style === 'step');
      expect(tile).toMatchObject({ style: 'step', width: 256, height: 256, extent: { kind: 'tile', z: 8, x: 159, y: 96 } });
    }
    expect(distinctTilePair).toBe(true);
    const before = await readFile(result.report.path);
    await expect(runEvaluation({
      controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut, frames: [frameId], provider: provider()
    })).rejects.toThrow('already exists');
    expect(await readFile(result.report.path)).toEqual(before);
  });


  it('emits only profile-supported variants and never silently retains ridge options', async () => {
    const values = await fixture();
    const result = await runEvaluation({
      controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut,
      frames: [frameId], provider: provider()
    });
    const variants = result.deterministic.variants;
    expect(variants.map(variant => variant.variant)).toEqual([
      'stored-clearance', 'native', 'candidate-neutral', 'candidate-supported-clearance'
    ]);
    expect(new Set(variants.map(variant => variant.variant)).size).toBe(4);
    expect(variants.some(variant => variant.variant.includes('ridge'))).toBe(false);
    for (const variant of variants) if (variant.parameters) expect(variant.parameters).not.toHaveProperty('surfaceMode');
    expect(variants.find(variant => variant.variant === 'candidate-neutral')!.parameters).toEqual({
      bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000
    });
    expect(variants.find(variant => variant.variant === 'candidate-supported-clearance')!.parameters).toEqual({
      bridgeMode: 'neutral', maximumBelowGroundExtrapolationM: 1000, clearanceFallback: 'unsupported'
    });
    expect(result.deterministic).not.toHaveProperty('hybridParameters');
  });

  it('passes same-frame stored clearance to both bounded fallback variants', async () => {
    const depths = [500, 650] as const;
    const elevationAt = (index: number) => -1000 + index * 5;
    const values = await fixture({ terrainElevation: elevationAt, clearanceDepthM: depths });
    const result = await runEvaluation({
      controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut,
      frames: [frameId, nextFrameId], provider: provider()
    });
    const expectedDepth = new Map([[frameId, depths[0]], [nextFrameId, depths[1]]]);
    const neutral = result.deterministic.variants.find(variant => variant.variant === 'candidate-neutral')!;
    expect(neutral.metrics.filledBelowGroundBridgeExceeded).toBe(0);
    expect(neutral.metrics.clearance).toBe(0);
    expect(neutral.metrics.belowGroundBridgeExceeded).toBeGreaterThan(0);
    for (const id of ['candidate-supported-clearance']) {
      const variants = result.deterministic.variants.filter(variant => variant.variant === id);
      expect(variants.map(variant => variant.frame)).toEqual([frameId, nextFrameId]);
      for (const variant of variants) {
        const depth = expectedDepth.get(variant.frame)!;
        expect(variant.metrics.filledBelowGroundBridgeExceeded).toBeGreaterThan(0);
        expect(variant.metrics.clearance).toBe(variant.metrics.filledBelowGroundBridgeExceeded);
        expect(variant.probes).toHaveLength(4);
        const clearanceProbes = variant.probes.filter(probe => probe.provenance === 'clearance');
        expect(clearanceProbes.length).toBeGreaterThan(0);
        for (const probe of clearanceProbes) {
          expect(probe.provenance).toBe('clearance');
          expect(probe.agl!).toBeCloseTo(depth, 4);
          expect(probe.msl!).toBeCloseTo(Math.fround(elevationAt(probe.index) + depth), 4);
          expect(probe.surfaceTemperatureK).toBeNull();
          expect(probe.depthM).toBeNull();
          expect(probe.maxBelowGroundDepthM).toBeGreaterThan(1000);
          expect(Array.isArray(probe.donorIndices)).toBe(true);
          expect(Array.isArray(probe.donorWeights)).toBe(true);
        }
      }
    }
  });

  it('preserves the fallback contract when stored clearance is unknown', async () => {
    const elevationAt = (index: number) => -1000 + index * 5;
    const values = await fixture({ terrainElevation: elevationAt, clearanceDepthM: [null, null] });
    const result = await runEvaluation({
      controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut,
      frames: [frameId], provider: provider()
    });
    for (const id of ['candidate-supported-clearance']) {
      const variant = result.deterministic.variants.find(entry => entry.variant === id)!;
      expect(variant.metrics.filledBelowGroundBridgeExceeded).toBe(0);
      expect(variant.metrics.belowGroundBridgeExceeded).toBeGreaterThan(0);
      const terminal = variant.metrics.dark! + variant.metrics.invalidDem! + variant.metrics.missingDonor!
        + variant.metrics.invalidDonorInput! + variant.metrics.unsupportedHeight! + variant.metrics.belowGroundBridgeExceeded!
        + variant.metrics.invalidSurfaceState! + variant.metrics.solverRejected! + variant.metrics.valid! + variant.metrics.noLift!;
      expect(terminal).toBe(9);
      expect(variant.metrics.clearance).toBe(0);
      expect(variant.metrics.column).toBe(0);
      const failedProbes = variant.probes.filter(probe => probe.reason === 'belowGroundBridgeExceeded');
      expect(failedProbes.length).toBeGreaterThan(0);
      expect(failedProbes.length).toBeLessThanOrEqual(variant.metrics.belowGroundBridgeExceeded);
      for (const probe of failedProbes) {
        expect(probe.provenance).toBeNull();
        expect(probe.agl).toBeNull();
      }
    }
  });

  it('retries the same output after a failed staged run without publishing partial artifacts', async () => {
    const values = await fixture();
    await expect(runEvaluation({
      controlManifest: values.manifestPath,
      cacheDir: join(values.out, 'cache'),
      out: values.packageOut,
      frames: [frameId, nextFrameId],
      provider: provider({ failHour: 10 })
    })).rejects.toThrow('Injected acquisition failure');
    await expect(readFile(join(values.packageOut, buildId, 'report.json'))).rejects.toThrow();
    await expect(readFile(join(values.packageOut, buildId, 'images', `${frameId}_stored-clearance_usable-lift-msl-step.webp`))).rejects.toThrow();
    const result = await runEvaluation({
      controlManifest: values.manifestPath,
      cacheDir: join(values.out, 'cache'),
      out: values.packageOut,
      frames: [frameId, nextFrameId],
      provider: provider()
    });
    expect(result.deterministic.variants.filter(variant => variant.frame === nextFrameId)).toHaveLength(4);
    expect((await readFile(result.report.path)).byteLength).toBe(result.report.bytes);
  });


  it('publishes one concurrent run and preserves its completed report without clobbering', async () => {
    const values = await fixture();
    const results = await Promise.allSettled([
      runEvaluation({ controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut, frames: [frameId], provider: provider() }),
      runEvaluation({ controlManifest: values.manifestPath, cacheDir: join(values.out, 'cache'), out: values.packageOut, frames: [frameId], provider: provider() })
    ]);
    const fulfilled = results.filter(result => result.status === 'fulfilled');
    const rejected = results.filter(result => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const winner = fulfilled[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof runEvaluation>>>;
    const bytes = await readFile(winner.value.report.path);
    expect(bytes.byteLength).toBe(winner.value.report.bytes);
    expect(JSON.parse(bytes.toString()).buildId).toBe(buildId);
    await expect(readFile(join(values.packageOut, buildId, 'report.json'))).resolves.toEqual(bytes);
  });
  it('rejects malicious manifest frame IDs before writing outside the build root', async () => {
    const values = await fixture();
    const manifest = JSON.parse(await readFile(values.manifestPath, 'utf8'));
    manifest.frames[0].id = '../../escape';
    for (const artifact of manifest.artifacts) if (artifact.frame === frameId) {
      artifact.frame = '../../escape';
      artifact.tilesKey = `builds/gfs/${buildId}/${artifact.layer}/../../escape.pmtiles`;
    }
    await writeFile(values.manifestPath, JSON.stringify(manifest));
    await expect(runEvaluation({
      controlManifest: values.manifestPath,
      cacheDir: join(values.out, 'cache'),
      out: values.packageOut,
      frames: [frameId],
      provider: provider()
    })).rejects.toThrow('Invalid frame ID');
    await expect(readFile(join(values.packageOut, buildId, 'report.json'))).rejects.toThrow();
  });

  it('preserves corrupt ICON cache and never fetches in offline read-only mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-offline-icon-')); roots.push(root);
    const cacheDir = join(root, 'cache'), iconCycle = '2026-10-08T00:00:00Z';
    const url = splitGribRegularFieldUrl(splitSource(SPLIT_PRODUCT), 'HSURF', iconCycle, { hour: 0, level: null });
    const fileName = url.split('/').at(-1)!, keyHash = createHash('sha256').update(url).digest('hex');
    const cachePath = join(cacheDir, 'objects', `${keyHash.slice(0, 16)}-${fileName}`);
    const corrupt = Buffer.from('corrupt-cache-object');
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, corrupt);
    let fetches = 0;
    const session = await createSplitGribAcquisitionSession(splitSource(SPLIT_PRODUCT), {
      cycle: iconCycle, activeIndices: Uint32Array.of(0), cacheDir, readOnlyCache: true, offline: true,
      fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); }
    });
    try {
      await expect(session.acquire(1)).rejects.toThrow('offline cache');
    } finally {
      await session.close();
    }
    expect(fetches).toBe(0);
    expect(await readFile(cachePath)).toEqual(corrupt);
  });

  it('rejects a GFS offline cache miss before any fetch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-offline-gfs-')); roots.push(root);
    let fetches = 0;
    const session = await createIndexedGribAcquisitionSession(indexedSource(INDEXED_PRODUCT), {
      cycle: '2026-10-30T00:00:00Z', activeIndices: Uint32Array.of(0), cacheDir: join(root, 'cache'), offline: true,
      fetchImpl: async () => { fetches++; throw new Error('unexpected fetch'); }
    });
    try {
      await expect(session.acquire(1)).rejects.toThrow('offline cache miss');
    } finally {
      await session.close();
    }
    expect(fetches).toBe(0);
  });


  it('emits unavailable for active target cells outside source coverage and validates written packs against the mask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'av-native-active-outside-')); roots.push(root);
    const sourceMask = mask(sourceGrid, sourceBounds);
    sourceMask.output.fill(0); sourceMask.halo.fill(0); setBit(sourceMask.output, 0);
    const targetMask = mask(patchGrid, patchBounds);
    targetMask.output.fill(0); targetMask.halo.fill(0);
    setBit(targetMask.output, 4); setBit(targetMask.halo, 1);
    const derived = {
      'usable-lift-msl': { values: new Float32Array(9).fill(1000), flags: new Uint8Array(9).fill(STATUS_VALID) },
      'usable-lift-agl': { values: new Float32Array(9).fill(800), flags: new Uint8Array(9).fill(STATUS_VALID) }
    };
    const sampled = sampleNativeTargetFields({ sourceMask, targetMask }, derived);
    for (const index of [1, 4]) {
      expect(sampled['usable-lift-msl'].flags[index]! & 3).toBe(STATUS_UNAVAILABLE);
      expect(Number.isNaN(sampled['usable-lift-msl'].values[index])).toBe(true);
    }
    expect(sampled['usable-lift-msl'].flags[2]! & 3).toBe(STATUS_OUTSIDE);

    const layout = prepareSamplePackLayout(targetMask.grid, targetMask.output, targetMask.halo);
    for (const layer of ['usable-lift-msl', 'usable-lift-agl'] as const) {
      const builder = createSamplePackBuilder(layout, 1), path = join(root, `${layer}.bin`);
      try {
        builder.writeChannel(0, sampled[layer]);
        await builder.finish(path);
      } finally {
        builder.close();
      }
      const bytes = await readFile(path);
      validateSampleFlags(bytes, bytes.byteLength, layer, targetMask);
      const decoded = decodeSamplePack(bytes, targetMask, ['f001'], [layer], 1);
      expect(decoded.fields.f001![layer]!.flags[1]! & 3).toBe(STATUS_UNAVAILABLE);
    }
  });
  it('samples large targets in bounded chunks and preserves uncovered cells as outside', () => {
    const sourceMask = mask(sourceGrid, sourceBounds);
    const largeGrid = {
      kind: 'regular-latlon' as const, width: 513, height: 513, earthRadiusM: 6371229,
      lon0: 44.0, lat0: 40.7, dx: 0.002, dy: -0.002, wrapLongitude: false
    };
    const output = new Uint8Array(Math.ceil(513 * 513 / 8)).fill(0xff);
    const targetMask: CoverageMask = { grid: largeGrid, bounds: [44, 39.674, 45.026, 40.7], output, halo: new Uint8Array(output.length), tiles: Uint8Array.of(1), maxZoom: 0 };
    const derived = {
      'usable-lift-msl': { values: new Float32Array(9).fill(1000), flags: new Uint8Array(9).fill(STATUS_VALID) },
      'usable-lift-agl': { values: new Float32Array(9).fill(800), flags: new Uint8Array(9).fill(STATUS_VALID) }
    };
    const sampled = sampleNativeTargetFields({ sourceMask, targetMask }, derived);
    expect(sampled['usable-lift-msl'].values.length).toBe(513 * 513);
    expect([...sampled['usable-lift-msl'].flags].some(flag => flag !== STATUS_OUTSIDE)).toBe(true);

    const sparseOutput = new Uint8Array(output.length);
    setBit(sparseOutput, 0);
    const sparseMask: CoverageMask = { ...targetMask, output: sparseOutput };
    const sparse = sampleNativeTargetFields({ sourceMask, targetMask: sparseMask }, derived);
    expect(sparse['usable-lift-msl'].flags[1]).toBe(STATUS_OUTSIDE);
    expect(Number.isNaN(sparse['usable-lift-msl'].values[1])).toBe(true);
  });
  it('requires the documented CLI arguments', async () => {
    await expect(runEvaluationCli([])).rejects.toThrow('requires --control-manifest, --cache-dir and --out');
  });
});
