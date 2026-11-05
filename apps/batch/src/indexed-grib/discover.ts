import { recentSourceCycles } from '../source.js';
import type { IndexedSource } from './source.js';
import { IndexedGribError } from './errors.ts';
import { cycleStamp, indexedGribCompanionSpecs, indexedGribCurrentSpecs, indexedGribFileUrl, indexedGribWindowNeedsCompanion } from './fields.ts';
import { IndexedGribTransport, selectIndexedGribRecord, type IndexResult, type IndexedGribTransportStats } from './transport.ts';
import type { DiscoveredIndexedGribRun, DiscoverIndexedGribRunOptions, IndexedGribFieldSpec } from './types.ts';


async function checkSpecList(source: IndexedSource,
  cycle: string,
  transport: IndexedGribTransport,
  indexes: Map<string, IndexResult>,
  specs: readonly IndexedGribFieldSpec[],
  hour: number,
  role: 'current' | 'companion',
  duplicates: DiscoveredIndexedGribRun['duplicates']
): Promise<void> {
  for (const spec of specs) {
    const index = indexes.get(`${spec.product}:${hour}`);
    if (!index) throw new IndexedGribError('run-unavailable', `Missing ${role === 'companion' ? 'companion ' : ''}Indexed GRIB index for ${spec.key}`);
    const url = indexedGribFileUrl(source, cycle, hour, source.upstream.products[spec.product]);
    const selection = await selectIndexedGribRecord(transport, url, index, spec);
    if (selection.duplicates) duplicates.push({ key: spec.key, role, url, verification: selection.duplicates });
  }
}

async function checkRun(source: IndexedSource, cycle: string, transport: IndexedGribTransport, refresh = false): Promise<DiscoveredIndexedGribRun> {
  const stamp = cycleStamp(cycle);
  const indexes = new Map<string, IndexResult>();
  const duplicates: DiscoveredIndexedGribRun['duplicates'] = [];
  const inventoryJobs = source.model.forecast.hours.flatMap(hour => Object.keys(source.upstream.products).map(product => ({ hour, product })));
  for (const { hour, product } of inventoryJobs) {
    const index = await transport.index(`${indexedGribFileUrl(source, cycle, hour, source.upstream.products[product])}.idx`, stamp, refresh);
    indexes.set(`${product}:${hour}`, index);
  }
  for (const hour of source.model.forecast.hours) {
    await checkSpecList(source, cycle, transport, indexes, indexedGribCurrentSpecs(source, hour), hour, 'current', duplicates);
    if (indexedGribWindowNeedsCompanion(source, hour)) {
      await checkSpecList(source, cycle, transport, indexes, indexedGribCompanionSpecs(source, hour), hour - source.model.forecast.intervalHours, 'companion', duplicates);
    }
  }
  return {
    cycle,
    products: { ...source.upstream.products },
    availableHours: [...source.model.forecast.hours],
    inventoryComplete: true,
    decodedAdmission: 'not-checked',
    duplicates,
    checkedAt: new Date().toISOString(),
  };
}

export async function discoverIndexedGribRun(source: IndexedSource, options: DiscoverIndexedGribRunOptions = {}, stats?: IndexedGribTransportStats): Promise<DiscoveredIndexedGribRun> {
  const transport = new IndexedGribTransport({ ...options, stats });
  return discoverIndexedGribRunWithTransport(source, options, transport);
}

// Shared transport keeps admitted inventories and duplicate evidence build-owned.
export async function discoverIndexedGribRunWithTransport(source: IndexedSource, options: DiscoverIndexedGribRunOptions, transport: IndexedGribTransport): Promise<DiscoveredIndexedGribRun> {
  const now = options.now ?? new Date();
  const failures: string[] = [];
  for (const cycle of recentSourceCycles(now, source.model.forecast.cycleHoursUtc, source.upstream.discoveryLagHours, source.upstream.discoveryCandidates).map(value => value.replace('.000Z', 'Z'))) {
    options.signal?.throwIfAborted();
    try {
      try { return await checkRun(source, cycle, transport); }
      catch (error) {
        // A cached inventory can have been captured while the provider was still writing it.
        // Refresh once only for missing records; scientific conflicts and corrupt bytes stay terminal.
        if (!(error instanceof IndexedGribError) || error.code !== 'record-missing') throw error;
        return await checkRun(source, cycle, transport, true);
      }
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (!(error instanceof IndexedGribError) || (error.code !== 'record-missing' && !(error.code === 'transport' && error.details?.reason === 'upstream-not-ready'))) throw error;
      failures.push(`${cycle}: ${(error as Error).message}`);
    }
  }
  throw new IndexedGribError('run-unavailable', 'No inventory-complete Indexed GRIB primary/secondary run found', {
    candidates: recentSourceCycles(now, source.model.forecast.cycleHoursUtc, source.upstream.discoveryLagHours, source.upstream.discoveryCandidates).map(value => value.replace('.000Z', 'Z')),
    failures,
  });
}
