import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GFS_GRID, GFS_PRODUCT, getBit, LIFT_RENDER_STYLE, manifestSchema, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, STATUS_OUTSIDE, STATUS_UNAVAILABLE, STATUS_VALID, type CoverageMask, type LayerId, type Manifest } from '@av/contracts';
import { deriveColumn, METHOD_ID, packCells, type GridField } from '@av/forecast';
import { createGfsAcquisitionSession, type GfsFrameAcquisition } from './noaa/index.js';
import { createRenderer } from './render.js';
import { WEBP_ENCODER } from './webp.js';
import { summarizeFields } from './summary.js';
import { prepareBuild } from './capacity.js';
import { writeSamplePack } from './sample-pack.js';
import { finalizeValidatedMetrics, loadCoverage, localPath, sha256, validateBuild, verifyCoverage } from './validate.js';

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
    const levels: { heightM: number; temperatureC: number }[] = [];
    for (let j = 0; j < frame.pressureLevelsHpa.length; j++) {
      const p = frame.pressureLevelsHpa[j];
      const heightM = read(frame.hgtM[j], frame.missing.hgt[j], i);
      if (p >= pressure || (Number.isFinite(heightM) && heightM <= terrain)) continue;
      levels.push({ heightM, temperatureC: read(frame.tempK[j], frame.missing.temp[j], i) - 273.15 });
    }
    const lift = deriveColumn({
      terrainM: terrain,
      surfaceTemperatureC: read(frame.temp2mK, frame.missing.temp2m, i) - 273.15,
      surfacePressureHpa: pressure,
      humidity: { specificHumidityKgKg: read(frame.specificHumidity2mKgKg, frame.missing.humidity2m, i) },
      sensibleHeatFluxWm2: read(frame.sensibleHeatFluxWm2, frame.missing.sensibleHeatFlux, i),
      latentHeatFluxWm2: read(frame.latentHeatFluxWm2, frame.missing.latentHeatFlux, i),
      pblHeightM: read(frame.pblHeightM, frame.missing.pbl, i),
      levels
    });
    result['usable-lift-msl'].values[index] = lift.msl.value ?? NaN;
    result['usable-lift-msl'].flags[index] = lift.msl.flags;
    result['usable-lift-agl'].values[index] = lift.agl.value ?? NaN;
    result['usable-lift-agl'].flags[index] = lift.agl.flags;
    const rain = read(frame.precipitationMmPerHour, frame.missing.precipitation, i);
    result['precip-rate'].values[index] = rain;
    result['precip-rate'].flags[index] = Number.isFinite(rain) && rain >= 0 ? STATUS_VALID : STATUS_UNAVAILABLE;
  }
  return result;
}

export async function buildSample(options: { out: string; cycle?: string; cacheDir?: string; onValidated?: (manifest: Manifest, path: string) => Promise<void> }): Promise<string> {
  const started = Date.now(), created = new Date(started), buildId = `${created.toISOString().replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}`;
  const root = resolve(options.out), mask = await loadCoverage();
  const cacheDir = options.cacheDir ?? join(root, '.cache', 'gfs');
  const requestedCycle = options.cycle;
  if (requestedCycle !== undefined && (!/^\d{4}-\d{2}-\d{2}T(?:00|06|12|18):00:00(?:\.000)?Z$/.test(requestedCycle) || !Number.isFinite(Date.parse(requestedCycle)) || new Date(requestedCycle).toISOString().replace('.000Z', 'Z') !== requestedCycle.replace('.000Z', 'Z'))) {
    throw new Error('Cycle must be a valid GFS 00/06/12/18Z ISO UTC timestamp');
  }
  const { indices, layout, capacity } = prepareBuild(mask), active = indices.active;
  const flatChannels: Uint8Array[] = [];
  const prefix = `builds/gfs/${buildId}`, frames: Manifest['frames'] = [], artifacts: Manifest['artifacts'] = [], receipts: unknown[] = [], summaries: Record<string, ReturnType<typeof summarizeFields>> = {};
  const counts = { active: active.length, tiles: capacity.tilesByZoom };
  const coverageHash = await verifyCoverage(mask);
  const methodSource = await readFile(SCIENCE_PATH);
  const renderer = createRenderer(mask);
  const acquisition = await createGfsAcquisitionSession({ cycle: requestedCycle, activeIndices: active, cacheDir });
  try {
    const cycle = new Date(acquisition.cycle).toISOString();
    let acquireMs = 0, deriveMs = 0, packMs = 0, renderMs = 0;
    for (const hour of GFS_PRODUCT.frameHours) {
      if (Date.now() - started > 6 * 3600000) throw new Error('Build exceeded six-hour publisher lifetime');
      const tAcquire = Date.now();
      const frame = await acquisition.acquire(hour);
      acquireMs += Date.now() - tAcquire;
      const start = new Date(Date.parse(cycle) + (hour - GFS_PRODUCT.intervalHours) * 3600000).toISOString(), end = new Date(Date.parse(cycle) + hour * 3600000).toISOString();
      const sameInstant = (actual: string, expected: string): boolean => Date.parse(actual) === Date.parse(expected);
      if (!sameInstant(frame.cycle, cycle) || frame.hour !== hour || !sameInstant(frame.validAt, end) || !sameInstant(frame.intervals.profileTime, end) || !sameInstant(frame.intervals.fluxWindow.start, start) || !sameInstant(frame.intervals.fluxWindow.end, end) || !sameInstant(frame.intervals.precipitationWindow.start, start) || !sameInstant(frame.intervals.precipitationWindow.end, end)) {
        throw new Error(`Acquisition interval mismatch f${hour}`);
      }
      const id = `f${String(hour).padStart(3, '0')}`;
      frames.push({ id, validTime: end, intervalStart: start, intervalEnd: end });
      receipts.push({ hour, intervals: frame.intervals, receipt: frame.receipt });
      const tDerive = Date.now();
      const fields = deriveFrame(frame, mask);
      summaries[id] = summarizeFields(fields, mask, indices.output);
      deriveMs += Date.now() - tDerive;
      for (const layer of GFS_PRODUCT.layers) {
        const tilesKey = `${prefix}/${layer}/${id}.pmtiles`, tilesPath = localPath(root, tilesKey);
        const tPack = Date.now();
        flatChannels.push(packCells(fields[layer]));
        packMs += Date.now() - tPack;
        const tRender = Date.now();
        await renderer.renderArchive(tilesPath, fields[layer], layer);
        const archive = await readFile(tilesPath);
        renderMs += Date.now() - tRender;
        artifacts.push({ layer, frame: id, tilesKey, tilesSha256: sha256(archive) });
      }
    }
    const tTranspose = Date.now(), samplesKey = `${prefix}/samples.bin`;
    const packed = await writeSamplePack(localPath(root, samplesKey), flatChannels, layout);
    packMs += Date.now() - tTranspose;
    const provenanceKey = `${prefix}/provenance.json`, provenancePath = localPath(root, provenanceKey);
    const provenanceBytes = Buffer.from(JSON.stringify({ version: 1, model: 'gfs', buildId, cycle, provider: 'NOAA', temporalApproximation: 'interval flux with endpoint profile and PBL', frames: receipts }));
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
    const baseManifest = {
      version: 2 as const,
      model: 'gfs' as const,
      buildId,
      cycle,
      createdAt: created.toISOString(),
      expiresAt: new Date(started + RETENTION_DAYS * 86400000).toISOString(),
      method: { id: METHOD_ID, hash: sha256(methodSource) },
      coverage: { id: GFS_PRODUCT.coverageId, hash: coverageHash, maskKey: `coverage/${GFS_PRODUCT.coverageId}/manifest.json`, maxZoom: GFS_PRODUCT.maxNativeZoom },
      grid: GFS_GRID,
      frames,
      layers: [...GFS_PRODUCT.layers],
      artifacts,
      samples: { format: 'cell-major-blocks-v1' as const, blockSize: SAMPLE_BLOCK_SIZE, storedCells: layout.storedCells, channelCount: flatChannels.length, bytes: packed.bytes, sha256: packed.sha256, key: samplesKey },
      source: {
        provider: 'NOAA',
        model: 'GFS',
        nativeResolutionDeg: 0.25,
        temporalApproximation: 'interval flux with endpoint profile and PBL',
        frameCount: frames.length,
        provenanceKey,
        provenanceSha256: sha256(provenanceBytes)
      },
      tool: { node: process.version, pmtiles: '1.31.2', tileFormat: 'webp', tileEncoder: WEBP_ENCODER, liftRenderStyle: LIFT_RENDER_STYLE },
      palettes: ['lift', 'rain']
    };
    const tValidate = Date.now();
    const validated = await validateBuild(root, manifestSchema.parse({ ...baseManifest, metrics: {} }), mask);
    const validateMs = Date.now() - tValidate;
    const manifest = finalizeValidatedMetrics(root, validated, {
      ...counts,
      frames: summaries,
      phasesMs: { acquireMs, deriveMs, packMs, renderMs, validateMs },
      renderer: renderer.metrics(),
      acquisition: acquisition.stats,
      capacity,
      packing: { indexBytes: layout.indexBytes },
      elapsedMs: Date.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024
    });
    const path = localPath(root, `${prefix}/manifest.json`);
    await writeFile(path, JSON.stringify(manifest), { flag: 'wx' });
    await options.onValidated?.(manifest, path);
    return path;
  } finally {
    await acquisition.close();
  }
}
