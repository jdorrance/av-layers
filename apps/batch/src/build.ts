import { randomUUID } from 'node:crypto';
import { getProduct } from '@av/contracts/models';
import { getForecastProvider } from './providers.js';
import { buildIdentity } from './identity.js';
import { loadCoverage } from './coverage.js';
import { assertForecastInputs, BUILD_BUDGETS } from './capacity.js';
import type { BuildStamp, ForecastInputs, FrameBuildOptions } from './frame-build.js';
import { prepareWholeDomain, type WholeDomainOptions } from './whole-domain/prepare.js';
import { buildWholeDomainFrames } from './whole-domain/frames.js';
import { finishWholeDomain, type FinishWholeDomainOptions } from './whole-domain/finish.js';

export interface BuildOptions extends FrameBuildOptions {
  onValidated?: FinishWholeDomainOptions['onValidated'];
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

export async function buildForecast(options: BuildOptions & ForecastInputs): Promise<string> {
  assertForecastInputs(options.mask, options.product);
  const stamp = createBuildStamp();
  const timeout = AbortSignal.timeout(BUILD_BUDGETS.elapsedMs);
  options = { ...options, signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout };
  const prepared = await prepareWholeDomain({ product: options.product, mask: options.mask, out: options.out,
    maxLevels: options.provider.maxLevels, wholeDomain: options.wholeDomain, signal: options.signal });
  const coverageHash = prepared.native.hash;
  const identity = await buildIdentity(options.product, coverageHash, { wholeDomain: {
    k: prepared.plan.k, fineCoverageHash: prepared.fine.hash, fineGridHash: prepared.fine.descriptor.gridHash,
    nativeCoverageHash: prepared.native.hash, terrain: prepared.terrain } });
  const preparation = { elapsedMs: Date.now() - Date.parse(stamp.createdAt), peakRssBytes: process.resourceUsage().maxRSS * 1024 };
  const prefix = `builds/${options.product.modelId}/${stamp.buildId}`;
  const result = await buildWholeDomainFrames({ ...options, ...stamp, prepared, journalPrefix: prefix });
  return finishWholeDomain({ ...options, ...stamp, prepared, result, identity, preparation });
}
