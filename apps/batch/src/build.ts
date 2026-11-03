import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getProduct, createProductDescriptors, createProductMethodId, encodeBoundedJson, MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, LIFT_RENDER_STYLE, manifestSchema, RETENTION_DAYS, SAMPLE_BLOCK_SIZE } from '@av/contracts';
import { getForecastProvider } from './providers.js';
import { buildIdentity } from './identity.js';
import { loadCoverage, writeCoverage } from './coverage.js';
import { WEBP_ENCODER } from './webp.js';
import pmtiles from '../pmtiles.json' with { type: 'json' };
import { estimateCapacity, prepareBuild, type PreparedBuild } from './capacity.js';
import { failureReason } from './failure.js';
import { finalizeValidatedMetrics, localPath, sha256, validateBuild, type ValidatedBuild } from './validate.js';

import { buildFrames, type FrameBuildOptions, type BuildStamp, type ForecastInputs, type FrameBuildResult } from './frame-build.js';
export interface BuildOptions extends FrameBuildOptions { onValidated?: (result: ValidatedBuild, path: string) => Promise<void> }

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
  const prepared = prepareBuild(options.mask, options.product, options.provider);
  const coverageHash = await writeCoverage(resolve(options.out), options.mask, options.product);
  const identity = await buildIdentity(options.product, coverageHash);
  const prefix = `builds/${options.product.modelId}/${stamp.buildId}`;
  const result = await buildFrames({ ...options, ...stamp, prepared, samplesKey: `${prefix}/samples.bin`, journalPrefix: prefix });
  return finishForecast({ ...options, ...stamp, prepared, coverageHash, identity, result });
}

/** Assemble and validate a complete product once, before any publication callback. */
export async function finishForecast(options: Pick<BuildOptions, 'out' | 'signal' | 'onValidated'> & ForecastInputs & BuildStamp & {
  prepared: PreparedBuild; coverageHash: string; identity: Awaited<ReturnType<typeof buildIdentity>>; result: FrameBuildResult; execution?: Record<string, unknown>;
}): Promise<string> {
  const { product, mask, provider, buildId, createdAt, coverageHash, identity, result } = options;
  const root = resolve(options.out), started = Date.parse(createdAt), prefix = `builds/${product.modelId}/${buildId}`;
  const { layout, capacity: initialCapacity, indices } = options.prepared;
  const { frames, artifacts, receipts, samples: packed, cycle } = result, samplesKey = packed.key;
  const channelCount = frames.length * product.layers.length;
  const capacity = frames.length === product.frameHours.length ? initialCapacity : {
    ...initialCapacity,
    ...estimateCapacity(mask, product, layout.storedCells, { frames: frames.length })
  };
  const descriptors = createProductDescriptors(product);
  await mkdir(localPath(root, prefix), { recursive: true });
  let phase = 'provenance';
  try {
    const provenanceKey = `${prefix}/provenance.json`, provenancePath = localPath(root, provenanceKey);
    const provenanceBytes = encodeBoundedJson({ version: 1, model: product.modelId, buildId, cycle, provider: provider.provider, temporalApproximation: 'interval flux with endpoint profile and PBL', frames: receipts }, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS);
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
    const baseManifest = {
      version: 3 as const,
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
        temporalApproximation: 'interval flux with endpoint profile and PBL',
        frameCount: frames.length,
        provenanceKey,
        provenanceSha256: sha256(provenanceBytes)
      },
      tool: { components: identity.components, node: process.version, pmtiles: pmtiles.version, tileFormat: 'webp', tileEncoder: WEBP_ENCODER, liftRenderStyle: LIFT_RENDER_STYLE },
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
    await writeFile(path, encodeBoundedJson(completed.manifest, MAX_MANIFEST_BYTES), { flag: 'wx' });
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
