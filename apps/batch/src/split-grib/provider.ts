import type { ModelDefinition } from '@av/contracts';
import type { ResolvableForecastProvider } from '../provider.js';
import { splitSource } from './source.js';

export function createSplitGribProvider(model: ModelDefinition): ResolvableForecastProvider {
  const source = splitSource(model);
  return { id: model.source.configurationId, provider: source.upstream.provider,
    maxLevels: model.capabilities.maxVerticalLevels, directTargets: true, retainedGeometryFields: source.modelLevels.length + 1,
    auxiliarySurfaceFields: Object.keys(source.upstream.auxSurface ?? {}).length,
    auxiliaryLevelFields: Object.keys(source.upstream.auxLevels ?? {}).length,
    async resolveCycle(options) {
      options.signal?.throwIfAborted();
      const { validateSplitGribCycle } = await import('./fields.js');
      if (options.cycle !== undefined) return validateSplitGribCycle(source, options.cycle);
      const { discoverSplitGribRun } = await import('./discover.js');
      return validateSplitGribCycle(source, (await discoverSplitGribRun(source, options)).cycle);
    },
    async proveInputs(options) { return (await import('../input-proof.js')).proveForecastInputs(model, this, options); },
    async open(options) { return (await import('./acquire.js')).createSplitGribAcquisitionSession(source, options); }
  };
}
