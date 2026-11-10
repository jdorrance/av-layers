import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getProduct, createProductDescriptors, createProductMethodId, createRefinementDescriptors, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, liftRenderStyle, manifestSchema, PALETTES, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE } from '@av/contracts';
import { getForecastProvider } from './providers.js';
import { buildIdentity } from './identity.js';
import { loadCoverage, writeCoverage } from './coverage.js';
import { WEBP_ENCODER } from './webp.js';
import { RASTER_SAMPLING } from './raster.js';
import pmtiles from '../pmtiles.json' with { type: 'json' };
import { BUILD_BUDGETS, estimateCapacity, prepareBuild, type PreparedBuild } from './capacity.js';
import { failureReason } from './failure.js';
import { finalizeValidatedMetrics, localPath, sha256, validateBuild, type ValidatedBuild } from './validate.js';

import type { PreparedTerrainRef } from './terrain/prepare.js';
import { prepareRefinements, loadRefinements } from './refinement/prepare.js';
import type { TerrainAsset, TerrainStorage } from './terrain/contract.js';
import { buildFrames, type FrameBuildOptions, type BuildStamp, type ForecastInputs, type FrameBuildResult } from './frame-build.js';
import { prepareWholeDomain, type WholeDomainOptions } from './whole-domain/prepare.js';
import { buildWholeDomainFrames } from './whole-domain/frames.js';
import { finishWholeDomain } from './whole-domain/finish.js';
export interface BuildOptions extends FrameBuildOptions {
  onValidated?: (result: ValidatedBuild, path: string) => Promise<void>;
  refinement?: { catalogRef: TerrainAsset; storage: TerrainStorage };
  wholeDomain?: WholeDomainOptions;
}

export function createBuildStamp(): BuildStamp {
  const createdAt = new Date().toISOString();
  return { createdAt, buildId: `${createdAt.replace(/[-:]/g, '').slice(0, 15)}Z-${randomUUID()}` };
}
export async function buildProduct(modelId: string, options: BuildOptions): Promise<string> {
  const product = getProduct(modelId), provider = getForecastProvider(modelId);
  if (!product) throw new Error(`No forecast product for ${modelId}`);
  return buildForecast({ ...options, product, mask: await loadCoverage(product), provider });
}

/** Local sequential execution and distributed workers share the same frame implementation. */
export async function buildForecast(options: BuildOptions & ForecastInputs): Promise<string> {
  const stamp = createBuildStamp();
  const deadlineAt = Date.parse(stamp.createdAt) + BUILD_BUDGETS.elapsedMs;
  const timeout = AbortSignal.timeout(Math.max(1, deadlineAt - Date.now()));
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
  if (options.product.terrainSubdivisionFactor !== undefined) return buildWholeDomainForecast(options, stamp);
  const inputs = options.refinement ? await prepareRefinements({ ...options.refinement, product: options.product, mask: options.mask, out: options.out, signal: options.signal }) : [];
  const refinements = await loadRefinements({ inputs, out: options.out, baseMask: options.mask, signal: options.signal });
  const prepared = prepareBuild(options.mask, options.product, { ...options.provider, terrainBytes: options.terrain?.arrayBytes, refinements });
  const coverageHash = await writeCoverage(resolve(options.out), options.mask, options.product);
  const identity = await buildIdentity(options.product, coverageHash, options.terrain, inputs);
  const prefix = `builds/${options.product.modelId}/${stamp.buildId}`;
  const result = await buildFrames({ ...options, ...stamp, prepared, samplesKey: `${prefix}/samples.bin`, journalPrefix: prefix });
  return finishForecast({ ...options, ...stamp, prepared, coverageHash, identity, result });
}

async function buildWholeDomainForecast(options: BuildOptions & ForecastInputs, stamp: BuildStamp): Promise<string> {
  const prepared = await prepareWholeDomain({ product: options.product, mask: options.mask, out: options.out,
    maxLevels: options.provider.maxLevels, wholeDomain: options.wholeDomain, signal: options.signal });
  const coverageHash = prepared.native.hash;
  const identity = await buildIdentity(options.product, coverageHash, undefined, [], undefined, {
    k: prepared.plan.k, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash,
    nativeCoverageHash: prepared.native.hash, terrain: prepared.terrain });
  const preparation = { elapsedMs: Date.now() - Date.parse(stamp.createdAt), peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  const prefix = `builds/${options.product.modelId}/${stamp.buildId}`;
  const result = await buildWholeDomainFrames({ ...options, ...stamp, prepared, journalPrefix: prefix });
  return finishWholeDomain({ ...options, ...stamp, prepared, result, identity, preparation });
}

/** Assemble and validate a complete product once, before any publication callback. */
export async function finishForecast(options: Pick<BuildOptions, 'out' | 'signal' | 'onValidated'> & ForecastInputs & BuildStamp & {
  prepared: PreparedBuild; coverageHash: string; identity: Awaited<ReturnType<typeof buildIdentity>>; result: FrameBuildResult; execution?: Record<string, unknown>; terrain?: PreparedTerrainRef;
}): Promise<string> {
  const { product, mask, provider, buildId, createdAt, coverageHash, identity, result } = options;
  const root = resolve(options.out), started = Date.parse(createdAt), prefix = `builds/${product.modelId}/${buildId}`;
  const { layout, capacity: initialCapacity, indices } = options.prepared;
  const { frames, artifacts, receipts, samples: packed, cycle } = result, samplesKey = packed.key;
  const channelCount = frames.length * product.layers.length;
  const capacity = frames.length === product.frameHours.length ? initialCapacity : {
    ...initialCapacity,
    ...estimateCapacity(mask, product, layout.storedCells, { frames: frames.length }, initialCapacity.refinement)
  };
  const descriptors = createProductDescriptors(product);
  await mkdir(localPath(root, prefix), { recursive: true });
  let phase = 'provenance';
  try {
    const refined = result.refinements ?? [];
    if (refined.length !== options.prepared.refinements.length || refined.some((item, index) => item.id !== options.prepared.refinements[index].input.id)) throw new Error('Incomplete or reordered refinement results');
    const refinementMethod = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate];
    const patches = options.prepared.refinements.map(({ input, layout, terrain }, index) => ({
      id: input.id, grid: input.grid, coverage: input.coverage, geometry: input.geometry,
      descriptors: createRefinementDescriptors(product, input.bounds), layers: [...refinementMethod.outputs],
      samples: { format: 'cell-major-blocks-v1' as const, blockSize: SAMPLE_BLOCK_SIZE, storedCells: layout.storedCells, ...refined[index].samples },
      method: { id: refinementMethod.id, hash: identity.scienceHash },
      terrain: { dataId: terrain.descriptor.dataId, key: input.terrain.key, sha256: input.terrain.sha256,
        verticalDatum: terrain.descriptor.source.verticalDatum, surface: terrain.descriptor.source.surface }
    }));
    const provenanceKey = `${prefix}/provenance.json`, provenancePath = localPath(root, provenanceKey);
    const provenanceBytes = encodeBoundedJson({ version: 1, model: product.modelId, buildId, cycle, provider: provider.provider, temporalApproximation: 'interval flux with endpoint profile', frames: receipts }, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS);
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
    const baseManifest = {
      version: patches.length ? 4 as const : 3 as const,
      ...(patches.length ? { patches } : {}),
      descriptors, recipe: identity.recipe,
      model: product.modelId,
      buildId,
      cycle,
      createdAt,
      expiresAt: new Date(started + RETENTION_DAYS * 86400000).toISOString(),
      method: { id: createProductMethodId(product), hash: identity.scienceHash },
      coverage: { id: product.coverageId, hash: coverageHash, maskKey: `coverage/${coverageHash}/manifest.json`, maxZoom: product.maxNativeZoom },
      grid: product.grid,
      frames,
      layers: [...product.layers],
      artifacts,
      samples: { format: 'cell-major-blocks-v1' as const, blockSize: SAMPLE_BLOCK_SIZE, storedCells: layout.storedCells, channelCount, bytes: packed.bytes, sha256: packed.sha256, key: samplesKey },
      source: {
        provider: provider.provider,
        model: product.modelId,
        temporalApproximation: 'interval flux with endpoint profile',
        frameCount: frames.length,
        provenanceKey,
        provenanceSha256: sha256(provenanceBytes),
        ...(options.terrain ? { terrain: options.terrain } : {})
      },
      tool: { components: identity.components, node: process.version, pmtiles: pmtiles.version, tileFormat: 'webp', tileEncoder: WEBP_ENCODER, liftRenderStyle: liftRenderStyle(PALETTES.lift.interpolation), ...RASTER_SAMPLING },
      palettes: descriptors.palettes.map(p => p.id)
    };
    const tValidate = Date.now();
    phase = 'validate';
    const validated = await validateBuild(root, manifestSchema.parse({ ...baseManifest, metrics: {} }), mask, coverageHash, product);
    const validateMs = Date.now() - tValidate;
    const completed = finalizeValidatedMetrics(root, validated, {
      ...result.metrics,
      active: indices.active.length, tiles: capacity.tilesByZoom,
      phasesMs: { ...result.metrics.phasesMs, validateMs },
      ...(options.execution ? { execution: options.execution } : {}),
      capacity,
      packing: { indexBytes: layout.indexBytes },
      elapsedMs: Date.now() - started,
      peakRssBytes: Math.max(result.metrics.peakRssBytes, process.resourceUsage().maxRSS * 1024)
    });
    const path = localPath(root, `${prefix}/manifest.json`);
    phase = 'write-manifest';
    await writeFile(path, encodeBoundedJson(completed.manifest, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS), { flag: 'wx' });
    await writeFile(localPath(root, `${prefix}/progress.json`), JSON.stringify({ state: 'validated', buildId, elapsedMs: Date.now() - started }));
    options.signal?.throwIfAborted();
    phase = 'on-validated';
    await options.onValidated?.(completed, path);
    return path;
  } catch (error) {
    await writeFile(localPath(root, `${prefix}/failure.json`), JSON.stringify({ version: 1, state: 'failed', buildId, provider: provider.id, cycle, phase, failedFrameHour: null, completedFrames: frames.length, elapsedMs: Date.now() - started, cancelled: options.signal?.aborted ?? false, error: failureReason(error) }));
    throw error;
  }
}
