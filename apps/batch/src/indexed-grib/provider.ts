import type { ModelDefinition } from '@av/contracts';
import type { ResolvableForecastProvider } from '../provider.js';
import { indexedSource } from './source.js';

export function createIndexedGribProvider(model: ModelDefinition): ResolvableForecastProvider {
  const source = indexedSource(model);
  return { id: model.source.configurationId, provider: source.upstream.provider,
    maxLevels: model.capabilities.maxVerticalLevels, directTargets: true,
    auxiliarySurfaceFields: Object.keys(source.upstream.auxSurface ?? {}).length,
    auxiliaryLevelFields: Object.keys(source.upstream.auxLevels ?? {}).length,
    async resolveCycle(options) {
      options.signal?.throwIfAborted();
      const { validateCycle } = await import('./fields.js');
      if (options.cycle !== undefined) return validateCycle(source, options.cycle);
      const { discoverIndexedGribRun } = await import('./discover.js');
      return validateCycle(source, (await discoverIndexedGribRun(source, options)).cycle);
    },
    async proveInputs(options) { return (await import('../input-proof.js')).proveForecastInputs(model, this, options); },
    async open(options) { return (await import('./acquire.js')).createIndexedGribAcquisitionSession(source, options); }
  };
}
