import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { coverageIndices, matchesFrameIntervals, type ModelDefinition } from '@av/contracts';
import { validateNormalizedFrame } from '@av/forecast';
import { loadCoverage } from './coverage.js';
import { forecastFrame } from './frame-build.js';
import type { ResolvableForecastProvider } from './provider.js';

/** Verify every required source field at one public cell through the normal session boundary. */
export async function proveForecastInputs(product: ModelDefinition, provider: ResolvableForecastProvider,
  options: Parameters<ResolvableForecastProvider['proveInputs']>[0]) {
  const indices = coverageIndices(await loadCoverage(product)).output;
  if (!indices.length) throw new Error('Input proof requires public coverage');
  const active = Uint32Array.of(indices[0]!), hour = product.frameHours[Math.min(5, product.frameHours.length - 1)]!;
  const session = await provider.open({ ...options, activeIndices: active, cacheDir: options.cacheDir ?? join(tmpdir(), 'av-input-proof', product.modelId) });
  try {
    const frame = await session.acquire(hour);
    validateNormalizedFrame(frame, active, product.grid, provider.maxLevels, product.layers, product.capabilities.verticalCoordinate);
    if (!matchesFrameIntervals(frame.intervals, forecastFrame(frame.cycle, hour, product.intervalHours), product.layers.includes('precip-rate'))) throw new Error('Input proof interval mismatch');
    return { schemaVersion: 1, model: product.modelId, cycle: frame.cycle, hour, validAt: frame.validAt,
      grid: frame.grid, activeIndices: [...active], layers: product.layers, intervals: frame.intervals,
      transport: session.stats, receipt: frame.receipt };
  } finally { await session.close(); }
}
