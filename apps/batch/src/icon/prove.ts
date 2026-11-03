import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coverageIndices } from '@av/contracts';
import { validateNormalizedFrame } from '@av/forecast';
import { loadCoverage } from '../coverage.js';
import { ICON_EU_GRID, ICON_EU_MODEL_LEVELS, ICON_EU_PRODUCT } from './constants.js';
import { createIconEuAcquisitionSession } from './acquire.js';

export async function proveIconEuInputs(
  options: {
    readonly cycle?: string;
    readonly hour?: number;
    readonly cacheDir?: string;
    readonly baseUrl?: string;
    readonly fetchImpl?: typeof fetch;
    readonly signal?: AbortSignal;
  } = {}
) {
  const mask = await loadCoverage(ICON_EU_PRODUCT);
  const { active, output } = coverageIndices(mask);
  const cacheDir = options.cacheDir ?? join(tmpdir(), 'av-icon-eu-proof-cache');
  const hour = options.hour ?? 6;
  const session = await createIconEuAcquisitionSession({
    cycle: options.cycle,
    activeIndices: active,
    cacheDir,
    baseUrl: options.baseUrl,
    fetchImpl: options.fetchImpl,
    signal: options.signal
  });
  try {
    const frame = await session.acquire(hour);
    validateNormalizedFrame(
      frame,
      active,
      ICON_EU_GRID,
      ICON_EU_MODEL_LEVELS.length,
      ICON_EU_PRODUCT.layers
    );
    return {
      schemaVersion: 1,
      model: 'icon-eu',
      cycle: frame.cycle,
      hour: frame.hour,
      validAt: frame.validAt,
      grid: ICON_EU_GRID,
      outputCells: output.length,
      activeCells: active.length,
      modelLevels: [...ICON_EU_MODEL_LEVELS],
      layers: [...ICON_EU_PRODUCT.layers],
      intervals: frame.intervals,
      transport: session.stats
    };
  } finally {
    await session.close();
  }
}
