import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GFS_GRID, getBit, LAYER_IDS, LIFT_RENDER_STYLE, manifestSchema, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type CoverageMask, type LayerId, type Manifest } from '@av/contracts';
import { deriveColumn, METHOD_ID, packCells, type GridField } from '@av/forecast';
import { acquireGfsFrame, discoverGfsRun, type GfsFrameAcquisition } from './noaa/index.js';
import { renderArchive } from './render.js';
import { summarizeFields } from './summary.js';
import { loadCoverage, localPath, sha256, validateBuild, verifyCoverage } from './validate.js';

const SCIENCE_PATH = fileURLToPath(new URL('../../../packages/forecast/src/science.ts', import.meta.url));

function field(): GridField {
  const size = GFS_GRID.width * GFS_GRID.height;
  return { values: new Float32Array(size), flags: new Uint8Array(size).fill(STATUS_OUTSIDE) };
}

export function deriveFrame(frame: GfsFrameAcquisition, mask: CoverageMask): Record<LayerId, GridField> {
  const result = { 'usable-lift-msl': field(), 'usable-lift-agl': field(), 'precip-rate': field() };
  const read = (values: Float32Array, missing: Uint8Array, i: number): number => missing[i] ? NaN : values[i];
  for (let i = 0; i < frame.activeIndices.length; i++) {
    const index = frame.activeIndices[i];
    if (!getBit(mask.output, index) && !getBit(mask.halo, index)) throw new Error('Acquisition returned inactive index');
    const pressure = read(frame.surfacePressurePa, frame.missing.surfacePressure, i) / 100;
    const terrain = read(frame.terrainM, frame.missing.terrain, i);
    const levels = frame.pressureLevelsHpa.flatMap((p, j) => {
      const heightM = read(frame.hgtM[j], frame.missing.hgt[j], i);
      return p >= pressure || (Number.isFinite(heightM) && heightM <= terrain) ? [] : [{ heightM, temperatureC: read(frame.tempK[j], frame.missing.temp[j], i) - 273.15 }];
    });
    const lift = deriveColumn({ terrainM: terrain, surfaceTemperatureC: read(frame.temp2mK, frame.missing.temp2m, i) - 273.15, surfacePressureHpa: pressure, humidity: { specificHumidityKgKg: read(frame.specificHumidity2mKgKg, frame.missing.humidity2m, i) }, sensibleHeatFluxWm2: read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux, i), latentHeatFluxWm2: read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i), pblHeightM: read(frame.pblHeightM, frame.missing.pbl, i), levels });
    for (const [layer, value] of [['usable-lift-msl', lift.msl], ['usable-lift-agl', lift.agl]] as const) {
      result[layer].values[index] = value.value ?? NaN;
      result[layer].flags[index] = value.flags;
    }
    const rain = read(frame.precipitationMmPerHour, frame.missing.precipitation, i);
    result['precip-rate'].values[index] = rain;
    result['precip-rate'].flags[index] = Number.isFinite(rain) && rain >= 0 ? STATUS_VALID : STATUS_UNAVAILABLE;
  }
  return result;
}

export async function buildSample(options: { out: string; cycle?: string; cacheDir?: string }): Promise<string> {
  const started = Date.now(), created = new Date(started), buildId = `${created.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}`;
  const root = resolve(options.out), mask = await loadCoverage();
  const cacheDir = options.cacheDir ?? join(root, '.cache', 'gfs');
  const requestedCycle = options.cycle ?? (await discoverGfsRun({ cacheDir })).cycle;
  if (!/^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00(?:\.000)?Z$/.test(requestedCycle) || !Number.isFinite(Date.parse(requestedCycle)) || new Date(requestedCycle).toISOString().replace('.000Z', 'Z') !== requestedCycle.replace('.000Z', 'Z')) throw new Error('Cycle must be a valid GFS 00/06/12/18Z ISO UTC timestamp');
  const cycle = new Date(requestedCycle).toISOString();
  const active = new Uint32Array(Array.from({ length: GFS_GRID.width * GFS_GRID.height }, (_, i) => i).filter(i => getBit(mask.output, i) || getBit(mask.halo, i)));
  const prefix = `builds/gfs/${buildId}`, frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: unknown[] = [], summaries: Record<string, ReturnType<typeof summarizeFields>> = {};
  const counts = { active: active.length, tiles: Array.from({ length: 6 }, (_, z) => { let n = 0; for (let y = 0; y < 2 ** z; y++) for (let x = 0; x < 2 ** z; x++) if (getBit(mask.tiles, (4 ** z - 1) / 3 + y * 2 ** z + x)) n++; return n; }) };
  const coverageHash = await verifyCoverage(mask);
  const methodSource = await readFile(SCIENCE_PATH);
  let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
  for (let hour = 3; hour <= 24; hour += 3) {
    if (Date.now() - started > 6 * 3600000) throw new Error('Build exceeded six-hour publisher lifetime');
    const tAcquire = Date.now();
    const frame = await acquireGfsFrame({ cycle, hour, activeIndices: active, cacheDir });
    acquireMs += Date.now() - tAcquire;
    const start = new Date(Date.parse(cycle) + (hour - 3) * 3600000).toISOString(), end = new Date(Date.parse(cycle) + hour * 3600000).toISOString();
    const sameInstant = (actual: string, expected: string): boolean => Date.parse(actual) === Date.parse(expected);
    if (!sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, end) || !sameInstant(frame.intervals.profileTime, end) || !sameInstant(frame.intervals.fluxWindow.start, start) || !sameInstant(frame.intervals.fluxWindow.end, end) || !sameInstant(frame.intervals.precipitationWindow.start, start) || !sameInstant(frame.intervals.precipitationWindow.end, end)) throw new Error(`Acquisition interval mismatch f${hour}`);
    const id = `f${String(hour).padStart(3, '0')}`;
    frames.push({ id, validTime: end, intervalStart: start, intervalEnd: end });
    receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
    const tDerive = Date.now();
    const fields = deriveFrame(frame, mask);
    summaries[id] = summarizeFields(fields, mask);
    deriveMs += Date.now() - tDerive;
    for (const layer of LAYER_IDS) {
      const samplesKey = `${prefix}/samples/${layer}/${id}.bin`, tilesKey = `${prefix}/${layer}/${id}.pmtiles`;
      const samplesPath = localPath(root, samplesKey), tilesPath = localPath(root, tilesKey);
      const tPack = Date.now();
      const samples = packCells(fields[layer]);
      await mkdir(dirname(samplesPath), { recursive: true });
      await writeFile(samplesPath, samples, { flag: 'wx' });
      packMs += Date.now() - tPack;
      const tRender = Date.now();
      await renderArchive(tilesPath, fields[layer], mask, layer);
      const archive = await readFile(tilesPath);
      renderMs += Date.now() - tRender;
      artifacts.push({ layer, frame: id, tilesKey, samplesKey, tilesSha256: sha256(archive), samplesSha256: sha256(samples) });
    }
  }
  const provenanceKey = `${prefix}/provenance.json`;
  const provenancePath = localPath(root, provenanceKey);
  const provenanceBytes = Buffer.from(JSON.stringify({ version: 1, model: 'gfs', buildId, cycle, provider: 'NOAA', temporalApproximation: 'interval flux with endpoint profile and PBL', frames: receipts }));
  await mkdir(dirname(provenancePath), { recursive: true });
  await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
  const sourceSummary = {
    provider: 'NOAA',
    model: 'GFS',
    nativeResolutionDeg: 0.25,
    temporalApproximation: 'interval flux with endpoint profile and PBL',
    frameCount: frames.length,
    provenanceKey,
    provenanceSha256: sha256(provenanceBytes)
  };
  const baseManifest = {
    version: 1 as const,
    model: 'gfs' as const,
    buildId,
    cycle,
    createdAt: created.toISOString(),
    expiresAt: new Date(started + 7 * 86400000).toISOString(),
    method: { id: METHOD_ID, hash: sha256(methodSource) },
    coverage: { id: 'soaring-land-v1', hash: coverageHash, maskKey: 'coverage/soaring-land-v1/manifest.json', maxZoom: 5 },
    grid: GFS_GRID,
    frames,
    layers: [...LAYER_IDS],
    artifacts,
    source: sourceSummary,
    tool: { node: process.version, pmtiles: '1.31.2', pngjs: '7.0.0', liftRenderStyle: LIFT_RENDER_STYLE },
    palettes: ['lift', 'rain']
  };
  const tValidate = Date.now();
  await validateBuild(root, manifestSchema.parse({ ...baseManifest, metrics: {} }), mask);
  const validateMs = Date.now() - tValidate;
  const manifest = manifestSchema.parse({
    ...baseManifest,
    metrics: {
      ...counts,
      frames: summaries,
      phasesMs: { acquireMs, deriveMs, packMs, renderMs, validateMs },
      elapsedMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024
    }
  });
  const path = localPath(root, `${prefix}/manifest.json`);
  await writeFile(path, JSON.stringify(manifest), { flag: 'wx' });
  return path;
}
