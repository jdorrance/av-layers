import type { ModelDefinition } from '@av/contracts';
import type { ResolvableForecastProvider } from '../provider.js';
import { indexedSource } from './source.js';

export function createIndexedGribProvider(model: ModelDefinition): ResolvableForecastProvider {
  const source = indexedSource(model);
  const resolveRun: NonNullable<ResolvableForecastProvider['resolveRun']> = async options => {
    const { discoverPrivateIndexedGribRun } = await import('./discover.js');
    const { run, sourcePin } = await discoverPrivateIndexedGribRun(source, options);
    return { cycle: run.cycle, sourcePin };
  };
  return { id: model.source.configurationId, provider: source.upstream.provider,
    maxLevels: model.capabilities.maxVerticalLevels, directTargets: true,
    auxiliarySurfaceFields: Object.keys(source.upstream.auxSurface ?? {}).length,
    auxiliaryLevelFields: Object.keys(source.upstream.auxLevels ?? {}).length,
    ...(source.privateR2 ? { resolveRun } : {}),
    async resolveCycle(options) {
      options.signal?.throwIfAborted();
      if (source.privateR2) return (await resolveRun(options)).cycle;
      const { validateCycle } = await import('./fields.js');
      if (options.cycle !== undefined) return validateCycle(source, options.cycle);
      const { discoverIndexedGribRun } = await import('./discover.js');
      return validateCycle(source, (await discoverIndexedGribRun(source, options)).cycle);
    },
    async proveInputs(options) { return (await import('../input-proof.js')).proveForecastInputs(model, this, options); },
    async open(options) { return (await import('./acquire.js')).createIndexedGribAcquisitionSession(source, options); }
  };
}
