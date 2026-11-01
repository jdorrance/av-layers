import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CELL_BYTES, GFS_GRID, setBit, STATUS_MASK, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type CoverageMask, type Manifest } from '@av/contracts';
import { sampleGrid, type GridField } from '@av/forecast';
import type { GfsFrameAcquisition } from './noaa/types.js';

const CYCLE = '2026-10-30T00:00:00.000Z';

vi.mock('./validate.js', async importOriginal => ({
  ...await importOriginal<typeof import('./validate.js')>(),
  loadCoverage: vi.fn(async () => { const output = new Uint8Array(129780); output[0] = 1; return { grid: GFS_GRID, output, halo: new Uint8Array(129780), tiles: new Uint8Array(2731), maxZoom: 7 }; }),
  verifyCoverage: vi.fn(async () => 'a'.repeat(64)),
  validateBuild: vi.fn(async (_root: string, manifest: Manifest) => manifest),
  finalizeValidatedMetrics: vi.fn((_root: string, manifest: Manifest, metrics: Manifest['metrics']) => ({ ...manifest, metrics })),
}));
vi.mock('./render.js', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const { dirname } = await import('node:path');
  const renderArchive = vi.fn(async (path: string, _field?: GridField, _mask?: CoverageMask, _layer?: Manifest['layers'][number]) => { await mkdir(dirname(path), { recursive: true }); await writeFile(path, new Uint8Array(1)); });
  return { renderArchive, createRenderer: vi.fn((mask: CoverageMask) => ({ renderArchive: (path: string, field: GridField, layer: Manifest['layers'][number]) => renderArchive(path, field, mask, layer), metrics: () => ({}) })) };
});
vi.mock('./summary.js', () => ({ summarizeFields: vi.fn(() => ({})) }));
vi.mock('@av/forecast', async importOriginal => ({ ...await importOriginal<typeof import('@av/forecast')>(), packCells: vi.fn(() => new Uint8Array(1)) }));
vi.mock('./sample-pack.js', () => ({ writeSamplePack: vi.fn(async (_path: string, inputs: string[], layout: { storedCells: number }) => ({ bytes: layout.storedCells * inputs.length * 5, sha256: 'c'.repeat(64) })) }));
vi.mock('./noaa/index.js', () => {
  const acquireGfsFrame = vi.fn(), discoverGfsRun = vi.fn();
  return { acquireGfsFrame, discoverGfsRun, createGfsAcquisitionSession: vi.fn(async (options: { cycle?: string; cacheDir?: string; activeIndices: Uint32Array }) => {
    const cycle = options.cycle ?? (await discoverGfsRun({ cacheDir: options.cacheDir })).cycle;
    return { cycle, acquire: (hour: number) => acquireGfsFrame({ ...options, cycle, hour }), close: vi.fn(async () => {}), stats: {} };
  }) };
});

import * as forecastModule from '@av/forecast';
import { acquireGfsFrame, createGfsAcquisitionSession, discoverGfsRun } from './noaa/index.js';
import { writeSamplePack } from './sample-pack.js';
import { buildSample, deriveFrame } from './build.js';
import * as renderModule from './render.js';
import * as summaryModule from './summary.js';
import * as validateModule from './validate.js';

const ms = (hour: number): string => new Date(Date.parse(CYCLE) + hour * 3600000).toISOString();
const noMs = (hour: number): string => ms(hour).replace('.000Z', 'Z');

function frame(hour: number): GfsFrameAcquisition {
  const empty = () => new Float32Array(0);
  return {
    schemaVersion: 1,
    model: 'gfs',
    cycle: noMs(0),
    hour,
    validAt: noMs(hour),
    capturedAt: '2026-10-30T08:25:13.148Z',
    grid: { width: GFS_GRID.width, height: GFS_GRID.height, lon0: -180, lat0: 90, dx: 0.25, dy: -0.25, wrapLongitude: true },
    activeIndices: new Uint32Array(0),
    terrainM: empty(),
    surfacePressurePa: empty(),
    temp2mK: empty(),
    specificHumidity2mKgKg: empty(),
    pblHeightM: empty(),
    sensibleHeatFluxWm2: empty(),
    latentHeatFluxWm2: empty(),
    precipitationMmPerHour: empty(),
    pressureLevelsHpa: [],
    hgtM: [],
    tempK: [],
    missing: {
      terrain: new Uint8Array(0),
      surfacePressure: new Uint8Array(0),
      temp2m: new Uint8Array(0),
      humidity2m: new Uint8Array(0),
      pbl: new Uint8Array(0),
      sensibleHeatFlux: new Uint8Array(0),
      latentHeatFlux: new Uint8Array(0),
      precipitation: new Uint8Array(0),
      hgt: [],
      temp: [],
    },
    intervals: {
      profileTime: noMs(hour),
      fluxWindow: { start: ms(hour - 3), end: ms(hour) },
      precipitationWindow: { start: ms(hour - 3), end: ms(hour) },
      fluxSourceWindow: { start: ms(0), end: ms(hour) },
      precipitationSourceWindow: { start: ms(0), end: ms(hour) },
      usedCompanion: hour > 3,
    },
    receipt: { schemaVersion: 1, cycle: noMs(0), hour, validAt: noMs(hour), capturedAt: '2026-10-30T08:25:13.148Z' },
  } as unknown as GfsFrameAcquisition;
}

const temp: string[] = [];
afterEach(async () => {
  await Promise.all(temp.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function run(acquire: (hour: number) => GfsFrameAcquisition, cycle = CYCLE, onValidated?: (manifest: Manifest, path: string) => Promise<void>): Promise<Manifest> {
  vi.mocked(acquireGfsFrame).mockImplementation(async options => acquire(options.hour));
  const out = await mkdtemp(join(tmpdir(), 'av-build-test-'));
  temp.push(out);
  const path = await buildSample({ out, cycle, cacheDir: join(out, 'cache'), onValidated });
  return JSON.parse((await readFile(path)).toString()) as Manifest;
}

describe('build sample acquisition intervals', () => {
  it('forwards the cache directory to discovery and acquisition', async () => {
    const out = await mkdtemp(join(tmpdir(), 'av-build-cache-')); temp.push(out);
    const cacheDir = join(out, 'cache');
    vi.mocked(discoverGfsRun).mockResolvedValue({ cycle: noMs(0) } as Awaited<ReturnType<typeof discoverGfsRun>>);
    vi.mocked(acquireGfsFrame).mockImplementation(async options => frame(options.hour));
    await buildSample({ out, cacheDir });
    expect(discoverGfsRun).toHaveBeenCalledWith({ cacheDir });
    expect(acquireGfsFrame).toHaveBeenCalledWith(expect.objectContaining({ cacheDir }));
  });
  it.each([CYCLE, noMs(0)])('accepts UTC cycle %s, writes external provenance.json, and records phase timings', async cycle => {
    const manifest = await run(frame, cycle);
    expect(manifest.cycle).toBe(CYCLE);
    expect(manifest.tool.liftRenderStyle).toBe('transparent-no-lift-v2');
    expect(manifest.frames.find(f => f.id === 'f003')).toEqual({ id: 'f003', validTime: ms(3), intervalStart: ms(0), intervalEnd: ms(3) });
    expect(manifest.frames.find(f => f.id === 'f006')).toEqual({ id: 'f006', validTime: ms(6), intervalStart: ms(3), intervalEnd: ms(6) });
    expect(manifest.source).toMatchObject({
      provider: 'NOAA',
      model: 'GFS',
      nativeResolutionDeg: 0.25,
      frameCount: 8,
      provenanceKey: `builds/gfs/${manifest.buildId}/provenance.json`
    });
    expect(manifest.source).not.toHaveProperty('frames');
    expect(manifest.metrics).toHaveProperty('phasesMs');
  });

  it.each([
    '2026-11-31T00:00:00Z',
    '2026-11-31T00:00:00.000Z',
    '2026-02-29T06:00:00Z',
    '2024-02-30T12:00:00.000Z',
    '2026-13-01T00:00:00Z',
    '2026-10-30T03:00:00Z',
  ])('rejects invalid calendar or cycle hour %s before acquisition', async cycle => {
    vi.mocked(acquireGfsFrame).mockClear();
    await expect(run(frame, cycle)).rejects.toThrow('Cycle must be a valid GFS');
    expect(acquireGfsFrame).not.toHaveBeenCalled();
  });

  it('rejects a frame cycle with a different actual instant', async () => {
    await expect(run(hour => ({ ...frame(hour), cycle: noMs(1) }))).rejects.toThrow('Acquisition interval mismatch f3');
    const session = await vi.mocked(createGfsAcquisitionSession).mock.results.at(-1)!.value;
    expect(session.close).toHaveBeenCalledOnce();
  });

  it('rejects a frame validAt and profile time with a different actual instant', async () => {
    await expect(run(hour => hour === 6 ? { ...frame(hour), validAt: noMs(5), intervals: { ...frame(hour).intervals, profileTime: noMs(5) } } : frame(hour))).rejects.toThrow('Acquisition interval mismatch f6');
  });

  it('rejects equivalent-format flux windows with a different actual instant', async () => {
    await expect(run(hour => hour === 6 ? { ...frame(hour), intervals: { ...frame(hour).intervals, fluxWindow: { start: ms(2), end: ms(5) } } } : frame(hour))).rejects.toThrow('Acquisition interval mismatch f6');
  });

  it('rejects equivalent-format precipitation windows with a different actual instant', async () => {
    await expect(run(hour => hour === 6 ? { ...frame(hour), intervals: { ...frame(hour).intervals, precipitationWindow: { start: ms(0), end: ms(6) } } } : frame(hour))).rejects.toThrow('Acquisition interval mismatch f6');
  });
});

describe('frame derivation', () => {
  function fixture(): { input: GfsFrameAcquisition; mask: CoverageMask; index: number } {
    const index = 360 * GFS_GRID.width + 720;
    const bits = Math.ceil(GFS_GRID.width * GFS_GRID.height / 8);
    const mask: CoverageMask = { grid: GFS_GRID, output: new Uint8Array(bits), halo: new Uint8Array(bits), tiles: new Uint8Array(1), maxZoom: 0 };
    setBit(mask.output, index); setBit(mask.halo, index + 1);
    const values = (v: number) => new Float32Array([v, v]);
    const missing = () => new Uint8Array(2);
    const input = { ...frame(3), activeIndices: new Uint32Array([index, index + 1]), terrainM: values(100), surfacePressurePa: values(100000), temp2mK: values(293.15), specificHumidity2mKgKg: values(0.008), pblHeightM: values(300), sensibleHeatFluxWm2: values(250), latentHeatFluxWm2: values(100), precipitationMmPerHour: new Float32Array([2, 4]), pressureLevelsHpa: [990, 950, 900], hgtM: [new Float32Array([100, 90]), values(600), values(1100)], tempK: [values(290), values(286.15), values(281.15)], missing: { terrain: missing(), surfacePressure: missing(), temp2m: missing(), humidity2m: missing(), pbl: missing(), sensibleHeatFlux: missing(), latentHeatFlux: missing(), precipitation: missing(), hgt: [missing(), missing(), missing()], temp: [missing(), missing(), missing()] } };
    return { input, mask, index };
  }

  it('derives halo contributors without publishing halo-only points', () => {
    const { input, mask, index } = fixture(), fields = deriveFrame(input, mask);
    expect(fields['precip-rate'].flags[index + 1]).toBe(STATUS_VALID);
    expect(fields['usable-lift-agl'].flags[index + 1] & STATUS_MASK).not.toBe(STATUS_UNAVAILABLE);
    const sample = sampleGrid(GFS_GRID, fields['precip-rate'], 0, 0.1, 'precip-rate', mask);
    expect(sample).toMatchObject({ status: STATUS_VALID, interpolated: true });
    expect(sample.value).toBeCloseTo(2.8);
    expect(sampleGrid(GFS_GRID, fields['precip-rate'], 0, 0.25, 'precip-rate', mask).status).toBe(STATUS_OUTSIDE);
  });

  it('drops finite subterranean heights but not missing profile levels', () => {
    const { input, mask, index } = fixture();
    expect(deriveFrame(input, mask)['usable-lift-agl'].flags[index] & STATUS_MASK).toBe(STATUS_VALID);
    expect(deriveFrame(input, mask)['usable-lift-agl'].flags[index + 1] & STATUS_MASK).toBe(STATUS_VALID);
    input.missing.hgt[1][0] = 1;
    input.missing.temp[1][1] = 1;
    expect(deriveFrame(input, mask)['usable-lift-agl'].flags[index] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
    expect(deriveFrame(input, mask)['usable-lift-agl'].flags[index + 1] & STATUS_MASK).toBe(STATUS_UNAVAILABLE);
  });
});

describe('bounded end-to-end build pipeline integration', () => {
  it('runs real packCells, summarizeFields, renderArchive and validateBuild across 8 frames × 3 layers', async () => {
    const actualValidate = await vi.importActual<typeof import('./validate.js')>('./validate.js');
    const actualRender = await vi.importActual<typeof import('./render.js')>('./render.js');
    const actualSummary = await vi.importActual<typeof import('./summary.js')>('./summary.js');
    const actualForecast = await vi.importActual<typeof import('@av/forecast')>('@av/forecast');
    const actualPack = await vi.importActual<typeof import('./sample-pack.js')>('./sample-pack.js');

    const index = 360 * GFS_GRID.width + 720;
    const boundedMask: CoverageMask = {
      grid: GFS_GRID,
      output: new Uint8Array(129780),
      halo: new Uint8Array(129780),
      tiles: new Uint8Array(2731),
      maxZoom: 7,
    };
    setBit(boundedMask.output, index);
    setBit(boundedMask.halo, index + 1);
    setBit(boundedMask.tiles, 0);
    setBit(boundedMask.tiles, (4 ** 7 - 1) / 3 + 64 * 128 + 64);
    const coverageHash = 'b'.repeat(64);

    vi.mocked(validateModule.loadCoverage).mockResolvedValueOnce(boundedMask);
    vi.mocked(validateModule.verifyCoverage).mockResolvedValueOnce(coverageHash);
    vi.mocked(validateModule.validateBuild).mockImplementationOnce(async (root, raw, mask) =>
      actualValidate.validateBuild(root, raw, mask, coverageHash)
    );
    vi.mocked(validateModule.finalizeValidatedMetrics).mockImplementationOnce(actualValidate.finalizeValidatedMetrics);
    vi.mocked(renderModule.renderArchive).mockImplementation(actualRender.renderArchive);
    vi.mocked(summaryModule.summarizeFields).mockImplementation(actualSummary.summarizeFields);
    vi.mocked(forecastModule.packCells).mockImplementation(actualForecast.packCells);
    vi.mocked(writeSamplePack).mockImplementationOnce(actualPack.writeSamplePack);

    try {
      const values = (v: number) => new Float32Array([v, v]);
      const missing = () => new Uint8Array(2);
      let completed: Manifest | undefined;
      const manifest = await run(hour => ({
        ...frame(hour),
        activeIndices: new Uint32Array([index, index + 1]),
        terrainM: values(100),
        surfacePressurePa: values(100000),
        temp2mK: values(293.15),
        specificHumidity2mKgKg: values(0.008),
        pblHeightM: values(300),
        sensibleHeatFluxWm2: values(250),
        latentHeatFluxWm2: values(100),
        precipitationMmPerHour: new Float32Array([2, 4]),
        pressureLevelsHpa: [990, 950, 900],
        hgtM: [new Float32Array([100, 90]), values(600), values(1100)],
        tempK: [values(290), values(286.15), values(281.15)],
        missing: {
          terrain: missing(),
          surfacePressure: missing(),
          temp2m: missing(),
          humidity2m: missing(),
          pbl: missing(),
          sensibleHeatFlux: missing(),
          latentHeatFlux: missing(),
          precipitation: missing(),
          hgt: [missing(), missing(), missing()],
          temp: [missing(), missing(), missing()],
        },
      }), CYCLE, async value => { completed = value; });

      expect(manifest.artifacts).toHaveLength(24);
      const outDir = temp.at(-1)!;
      expect(actualValidate.wasValidatedInProcess(outDir, completed)).toBe(true);
      expect(actualValidate.wasValidatedInProcess(outDir, manifest)).toBe(false); // A disk copy cannot impersonate the process-local result.
      expect(actualValidate.wasValidatedInProcess(join(outDir, 'another'), completed)).toBe(false);
      completed!.method.id = 'changed';
      expect(actualValidate.wasValidatedInProcess(outDir, completed)).toBe(false);
      expect(() => actualValidate.finalizeValidatedMetrics(outDir, completed!, {})).toThrow('changed');
      expect((await stat(join(outDir, manifest.samples.key))).size).toBe(manifest.samples.storedCells * 24 * CELL_BYTES);
      await expect(stat(join(outDir, '.work', manifest.buildId))).rejects.toMatchObject({ code: 'ENOENT' });
      for (const artifact of manifest.artifacts) {
        const tilesStat = await stat(join(outDir, artifact.tilesKey));
        expect(tilesStat.size).toBeGreaterThan(127); // More than the PMTiles header; buildSample already validated every decoded tile.
      }
    } finally {
      const { mkdir, writeFile } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      vi.mocked(renderModule.renderArchive).mockImplementation(async (path: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, new Uint8Array(1));
      });
      vi.mocked(summaryModule.summarizeFields).mockImplementation(() => ({}) as ReturnType<typeof actualSummary.summarizeFields>);
      vi.mocked(forecastModule.packCells).mockImplementation(() => new Uint8Array(1));
    }
  }, 60_000);
});
