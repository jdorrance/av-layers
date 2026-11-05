import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createWholeDomainDescriptors, encodeBoundedJson, manifestV5Schema, MAX_MANIFEST_BYTES,
  MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, RETENTION_DAYS, SAMPLE_BLOCK_SIZE, TERRAIN_CLEARANCE_METHOD, TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE,
  type ManifestV5 } from '@av/contracts';
import type { BuildStamp, ForecastInputs } from '../frame-build.js';
import { failureReason } from '../failure.js';
import { checkPerformance } from '../capacity.js';
import { finalizeValidatedMetrics, localPath, sha256, validateBuild, type ValidatedBuild } from '../validate.js';
import type { WholeDomainFrameResult } from './frames.js';
import type { WholeDomainPrepared } from './prepare.js';
import type { ObjectStorage } from '../storage.js';
import type { ObjectReceipt } from '../immutable-upload.js';

export interface FinishWholeDomainOptions extends ForecastInputs, BuildStamp {
  out: string; signal?: AbortSignal;
  prepared: WholeDomainPrepared;
  result: WholeDomainFrameResult;
  identity: { recipe: ManifestV5['recipe']; scienceHash: string; components: Record<string, string> };
  preparation?: { elapsedMs: number; peakRssBytes: number };
  assemblyStartedAt?: number;
  sampleGroups?: Partial<Record<'native' | 'fine', Extract<ManifestV5['surfaces'][number]['samples'], { format: 'frame-group-block-shards-v1' }>['shards']>>;
  remote?: { store: ObjectStorage; objects: ObjectReceipt[]; signal?: AbortSignal };
  onValidated?: (result: ValidatedBuild<ManifestV5>, path: string) => Promise<void>;
}

function rendererTotals(metrics: WholeDomainFrameResult['metrics']['renderer']) {
  const renderers = 'shards' in metrics ? metrics.shards : [metrics];
  if (!Array.isArray(renderers) || !renderers.length) throw new Error('Missing renderer metrics');
  const result = { native: { tiles: 0 }, fine: { tiles: 0 } };
  for (const renderer of renderers) for (const kind of ['native', 'fine'] as const) {
    const count = renderer?.[kind]?.tiles;
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('Invalid renderer tile count');
    result[kind].tiles += count;
  }
  return result;
}

export async function finishWholeDomain(options: FinishWholeDomainOptions): Promise<string> {
  const assemblyStartedAt = options.assemblyStartedAt ?? Date.now();
  const { product, provider, buildId, createdAt, result, prepared } = options;
  const root = resolve(options.out), started = Date.parse(createdAt), prefix = `builds/${product.modelId}/${buildId}`;
  await mkdir(localPath(root, prefix), { recursive: true });
  let phase = 'provenance';
  try {
    const provenanceKey = `${prefix}/provenance.json`, provenancePath = localPath(root, provenanceKey);
    const provenanceBytes = encodeBoundedJson({ version: 1, model: product.modelId, buildId, cycle: result.cycle, provider: provider.provider,
      temporalApproximation: 'interval flux with endpoint profile', frames: result.receipts }, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS);
    if (!('shards' in result.metrics.renderer)) await writeFile(localPath(root, `${prefix}/diagnostics.json`),
      encodeBoundedJson({ ...result.metrics, capacity: result.capacity }, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS), { flag: 'wx' });
    await mkdir(dirname(provenancePath), { recursive: true });
    await writeFile(provenancePath, provenanceBytes, { flag: 'wx' });
    const descriptors = createWholeDomainDescriptors(product);
    const refinementMethod = TERRAIN_COLUMN_METHODS_BY_VERTICAL_COORDINATE[product.capabilities.verticalCoordinate];
    const surfaces = result.surfaces.map(surface => {
      const layout = surface.layout, channelCount = result.frames.length * surface.layers.length;
      const baseSamples = { blockSize: SAMPLE_BLOCK_SIZE, channelOrder: 'frame-then-layer' as const,
        channelCount, coverageHash: surface.coverage.hash, blockCount: layout.blockCount, storedCells: layout.storedCells };
      const groups = options.sampleGroups?.[surface.id];
      const samples = groups ? { ...baseSamples, format: 'frame-group-block-shards-v1' as const, shards: groups }
        : { ...baseSamples, format: 'cell-major-block-shards-v1' as const,
          shards: surface.shards!.map(shard => ({ firstBlock: shard.firstBlock, blockCount: shard.blockCount, storedCells: shard.storedCells,
            bytes: shard.bytes, key: shard.key, sha256: shard.sha256 })) };
      return { id: surface.id, kind: surface.kind, grid: surface.grid, gridHash: surface.gridHash,
        coverage: { ...surface.coverage }, layers: [...surface.layers], samples,
        ...(surface.terrain ? { terrain: { dataId: surface.terrain.dataId, key: surface.terrain.ref.key, sha256: surface.terrain.ref.sha256,
          verticalDatum: surface.terrain.verticalDatum, surface: surface.terrain.surface, gridHash: surface.gridHash,
          coverageHash: surface.coverage.hash, layoutVersion: 1 as const } } : {}) };
    });
    const base = {
      version: 5 as const, descriptors, recipe: options.identity.recipe, model: product.modelId, buildId, cycle: result.cycle, createdAt,
      expiresAt: new Date(started + RETENTION_DAYS * 86400000).toISOString(),
      method: { id: [...new Set(product.layers.map(layer => descriptors.layers[layer].methodId))].join('+'), hash: options.identity.scienceHash },
      frames: result.frames, layers: [...product.layers], artifacts: result.artifacts, surfaces,
      source: { provider: provider.provider, model: product.modelId, temporalApproximation: 'interval flux with endpoint profile',
        frameCount: result.frames.length, provenanceKey, provenanceSha256: sha256(provenanceBytes),
        terrain: { dataId: surfaces.find(surface => surface.terrain)?.terrain?.dataId ?? '', key: prepared.terrain.key, sha256: prepared.terrain.sha256, arrayBytes: prepared.terrain.arrayBytes } },
      tool: { components: options.identity.components, node: process.version, tileFormat: 'webp', liftRenderStyle: 'transparent-no-lift-v2',
        terrainMethod: refinementMethod.id, terrainClearance: TERRAIN_CLEARANCE_METHOD.id },
      palettes: descriptors.palettes.map(palette => palette.id), metrics: {}
    };
    const tValidate = Date.now();
    phase = 'validate';
    const validated = await validateBuild(root, manifestV5Schema.parse(base), options.mask, undefined, product, options.remote);
    const completed = finalizeValidatedMetrics(root, validated, {
      elapsedMs: Date.now() - started,
      renderer: rendererTotals(result.metrics.renderer),
      peakRssBytes: Math.max(result.metrics.peakRssBytes, options.preparation?.peakRssBytes ?? 0, process.resourceUsage().maxRSS * 1024),
      phasesMs: { ...result.metrics.phasesMs, ...(options.preparation ? { preparationMs: options.preparation.elapsedMs } : {}), assemblyMs: tValidate - assemblyStartedAt, validateMs: Date.now() - tValidate },
      active: prepared.acquisitionActive.length, capacity: result.capacity,
      packing: { nativeIndexBytes: result.surfaces.find(s => s.id === 'native')?.layout.indexBytes ?? 0,
        fineIndexBytes: result.surfaces.find(s => s.id === 'fine')?.layout.indexBytes ?? 0 }
    });
    const performance = checkPerformance(completed.manifest);
    if (!performance.passed) throw new Error(`Whole-domain build exceeds performance budget: ${performance.failures.join('; ')}`);
    const path = localPath(root, `${prefix}/manifest.json`);
    phase = 'write-manifest';
    await writeFile(path, encodeBoundedJson(completed.manifest, MAX_MANIFEST_BYTES), { flag: 'wx' });
    await writeFile(localPath(root, `${prefix}/progress.json`), JSON.stringify({ state: 'validated', buildId, elapsedMs: Date.now() - started, version: 5 }));
    options.signal?.throwIfAborted();
    phase = 'on-validated';
    await options.onValidated?.(completed, path);
    return path;
  } catch (error) {
    await writeFile(localPath(root, `${prefix}/failure.json`), JSON.stringify({ version: 1, state: 'failed', buildId, provider: provider.id,
      cycle: result.cycle, phase, failedFrameHour: null, completedFrames: result.frames.length, elapsedMs: Date.now() - started,
      cancelled: options.signal?.aborted ?? false, error: failureReason(error) }));
    throw error;
  }
}
