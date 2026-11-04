import { GFS_PRODUCT } from '@av/contracts';
import type { ResolvableForecastProvider } from '../provider.js';

export const gfsProvider: ResolvableForecastProvider = {
  id: GFS_PRODUCT.source.configurationId,
  provider: 'NOAA',
  maxLevels: GFS_PRODUCT.capabilities.maxVerticalLevels,
  directTargets: true,
  async resolveCycle(options) {
    options.signal?.throwIfAborted();
    const { validateCycle } = await import('./fields.js');
    if (options.cycle !== undefined) return validateCycle(options.cycle);
    const { discoverGfsRun } = await import('./discover.js');
    return validateCycle((await discoverGfsRun(options)).cycle);
  },
  async proveInputs(options) {
    const { proveGfsInputs } = await import('./prove.js');
    return proveGfsInputs(options);
  },
  async open(options) {
    const { createGfsAcquisitionSession } = await import('./acquire.js');
    const session = await createGfsAcquisitionSession(options);
    return {
      cycle: session.cycle,
      get stats() {
        return { ...session.stats };
      },
      acquire: (hour, target) => session.acquire(hour, target),
      close: () => session.close()
    };
  }
};
