import {
  GFS_DISCOVERY_CANDIDATES,
  GFS_DISCOVERY_LAG_HOURS,
  GFS_FORECAST_HOURS,
  GFS_PRODUCTS,
} from './constants.ts';
import { NoaaError } from './errors.ts';
import { cycleStamp, gfsCompanionSpecs, gfsCurrentSpecs, gfsFileUrl, gfsWindowNeedsCompanion } from './fields.ts';
import { NoaaTransport, selectGfsRecord, type IndexResult, type NoaaTransportStats } from './transport.ts';
import type { DiscoveredGfsRun, DiscoverGfsRunOptions, GfsFieldSpec } from './types.ts';

function candidateCycles(now: Date): string[] {
  if (!Number.isFinite(now.getTime())) throw new NoaaError('invalid-option', 'Invalid discovery clock');
  const shifted = new Date(now.getTime() - GFS_DISCOVERY_LAG_HOURS * 3_600_000);
  shifted.setUTCMinutes(0, 0, 0);
  shifted.setUTCHours(Math.floor(shifted.getUTCHours() / 6) * 6);
  return Array.from({ length: GFS_DISCOVERY_CANDIDATES }, (_, i) =>
    new Date(shifted.getTime() - i * 6 * 3_600_000).toISOString().replace('.000Z', 'Z'),
  );
}

function productFor(spec: GfsFieldSpec): 'primary' | 'secondary' {
  return spec.product;
}

async function checkRun(cycle: string, transport: NoaaTransport): Promise<DiscoveredGfsRun> {
  const stamp = cycleStamp(cycle);
  const indexes = new Map<string, IndexResult>();
  const duplicates: DiscoveredGfsRun['duplicates'] = [];
  for (const hour of GFS_FORECAST_HOURS) {
    for (const product of ['primary', 'secondary'] as const) {
      const name = GFS_PRODUCTS[product];
      const index = await transport.index(`${gfsFileUrl(cycle, hour, name)}.idx`, stamp);
      indexes.set(`${product}:${hour}`, index);
    }
  }
  for (const hour of GFS_FORECAST_HOURS) {
    for (const spec of gfsCurrentSpecs(hour)) {
      const index = indexes.get(`${productFor(spec)}:${hour}`);
      if (!index) throw new NoaaError('run-unavailable', `Missing GFS index for ${spec.key}`);
      const url = gfsFileUrl(cycle, hour, GFS_PRODUCTS[spec.product]);
      const selection = await selectGfsRecord(transport, url, index, spec);
      if (selection.duplicates) duplicates.push({ key: spec.key, role: 'current', url, verification: selection.duplicates });
    }
    if (gfsWindowNeedsCompanion(hour)) {
      for (const spec of gfsCompanionSpecs(hour)) {
        const index = indexes.get(`${productFor(spec)}:${hour - 3}`);
        if (!index) throw new NoaaError('run-unavailable', `Missing companion GFS index for ${spec.key}`);
        const url = gfsFileUrl(cycle, hour - 3, GFS_PRODUCTS[spec.product]);
        const selection = await selectGfsRecord(transport, url, index, spec);
        if (selection.duplicates) duplicates.push({ key: spec.key, role: 'companion', url, verification: selection.duplicates });
      }
    }
  }
  return {
    cycle,
    products: { ...GFS_PRODUCTS },
    availableHours: [...GFS_FORECAST_HOURS],
    inventoryComplete: true,
    decodedAdmission: 'not-checked',
    duplicates,
    checkedAt: new Date().toISOString(),
  };
}

export async function discoverGfsRun(options: DiscoverGfsRunOptions = {}, stats?: NoaaTransportStats): Promise<DiscoveredGfsRun> {
  const now = options.now ?? new Date();
  const transport = new NoaaTransport({
    fetch: options.fetch,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
    cacheDir: options.cacheDir,
    stats,
  });
  const failures: string[] = [];
  for (const cycle of candidateCycles(now)) {
    options.signal?.throwIfAborted();
    try {
      return await checkRun(cycle, transport);
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`${cycle}: ${(error as Error).message}`);
    }
  }
  throw new NoaaError('run-unavailable', 'No inventory-complete GFS primary/secondary run found', {
    candidates: candidateCycles(now),
    failures,
  });
}
