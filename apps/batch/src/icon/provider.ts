import { ICON_EU_PRODUCT } from '@av/contracts';
import type { ResolvableForecastProvider } from '../provider.js';

export const iconEuProvider: ResolvableForecastProvider = {
  id: ICON_EU_PRODUCT.source.configurationId,
  provider: 'DWD',
  maxLevels: ICON_EU_PRODUCT.capabilities.maxVerticalLevels,
  retainedGeometryFields: ICON_EU_PRODUCT.capabilities.maxVerticalLevels + 1,
  async resolveCycle(options) {
    options.signal?.throwIfAborted();
    const { validateIconCycle } = await import('./fields.js');
    if (options.cycle !== undefined) return validateIconCycle(options.cycle);
    const { discoverIconEuRun } = await import('./discover.js');
    return validateIconCycle((await discoverIconEuRun(options)).cycle);
  },
  async proveInputs(options) {
    const { proveIconEuInputs } = await import('./prove.js');
    return proveIconEuInputs(options);
  },
  async open(options) {
    const { createIconEuAcquisitionSession } = await import('./acquire.js');
    const session = await createIconEuAcquisitionSession(options);
    return {
      cycle: session.cycle,
      get stats() {
        return { ...session.stats };
      },
      acquire: hour => session.acquire(hour),
      close: () => session.close()
    };
  }
};
