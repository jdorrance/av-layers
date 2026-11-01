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

async function checkSpecList(
  cycle: string,
  transport: NoaaTransport,
  indexes: Map<string, IndexResult>,
  specs: readonly GfsFieldSpec[],
  hour: number,
  role: 'current' | 'companion',
  duplicates: DiscoveredGfsRun['duplicates']
): Promise<void> {
  for (const spec of specs) {
    const index = indexes.get(`${spec.product}:${hour}`);
    if (!index) throw new NoaaError('run-unavailable', `Missing ${role === 'companion' ? 'companion ' : ''}GFS index for ${spec.key}`);
    const url = gfsFileUrl(cycle, hour, GFS_PRODUCTS[spec.product]);
    const selection = await selectGfsRecord(transport, url, index, spec);
    if (selection.duplicates) duplicates.push({ key: spec.key, role, url, verification: selection.duplicates });
  }
}

async function checkRun(cycle: string, transport: NoaaTransport, refresh = false): Promise<DiscoveredGfsRun> {
  const stamp = cycleStamp(cycle);
  const indexes = new Map<string, IndexResult>();
  const duplicates: DiscoveredGfsRun['duplicates'] = [];
  const inventoryJobs = GFS_FORECAST_HOURS.flatMap(hour => (['primary', 'secondary'] as const).map(product => ({ hour, product })));
  for (const { hour, product } of inventoryJobs) {
    const index = await transport.index(`${gfsFileUrl(cycle, hour, GFS_PRODUCTS[product])}.idx`, stamp, refresh);
    indexes.set(`${product}:${hour}`, index);
  }
  for (const hour of GFS_FORECAST_HOURS) {
    await checkSpecList(cycle, transport, indexes, gfsCurrentSpecs(hour), hour, 'current', duplicates);
    if (gfsWindowNeedsCompanion(hour)) {
      await checkSpecList(cycle, transport, indexes, gfsCompanionSpecs(hour), hour - 3, 'companion', duplicates);
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
  const transport = new NoaaTransport({ ...options, stats });
  return discoverGfsRunWithTransport(options, transport);
}

// Shared transport keeps admitted inventories and duplicate evidence build-owned.
export async function discoverGfsRunWithTransport(options: DiscoverGfsRunOptions, transport: NoaaTransport): Promise<DiscoveredGfsRun> {
  const now = options.now ?? new Date();
  const failures: string[] = [];
  for (const cycle of candidateCycles(now)) {
    options.signal?.throwIfAborted();
    try {
      try { return await checkRun(cycle, transport); }
      catch (error) {
        // A cached inventory can have been captured while the provider was still writing it.
        // Refresh once only for missing records; scientific conflicts and corrupt bytes stay terminal.
        if (!(error instanceof NoaaError) || error.code !== 'record-missing') throw error;
        return await checkRun(cycle, transport, true);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof NoaaError) || (error.code !== 'record-missing' && !(error.code === 'transport' && error.details?.reason === 'upstream-not-ready'))) throw error;
      failures.push(`${cycle}: ${(error as Error).message}`);
    }
  }
  throw new NoaaError('run-unavailable', 'No inventory-complete GFS primary/secondary run found', {
    candidates: candidateCycles(now),
    failures,
  });
}
