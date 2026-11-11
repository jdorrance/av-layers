import { sourceIntervalHours } from '@av/contracts';
import { recentSourceCycles } from '../source.js';
import { runConcurrent } from '../concurrent.js';
import type { IndexedSource } from './source.js';
import { IndexedGribError } from './errors.ts';
import { cycleStamp, indexedGribCompanionSpecs, indexedGribCurrentSpecs, indexedGribFileUrl, indexedGribWindowNeedsCompanion } from './fields.ts';
import { IndexedGribTransport, selectIndexedGribRecord, type IndexResult, type IndexedGribTransportStats } from './transport.ts';
import { readIndexedR2Run, verifyIndexedR2Objects } from './ready.ts';
import type { DiscoveredIndexedGribRun, DiscoverIndexedGribRunOptions, IndexedGribFieldSpec } from './types.ts';

function unavailableRun(error: unknown): boolean {
  return error instanceof IndexedGribError && (error.code === 'record-missing' ||
    (error.code === 'transport' && error.details?.reason === 'upstream-not-ready'));
}

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
  const lastHour = source.model.forecast.hours.at(-1)!;
  const loadInventory = async ({ hour, product }: { hour: number; product: string }): Promise<void> => {
    const index = await transport.index(`${indexedGribFileUrl(source, cycle, hour, source.upstream.products[product])}.idx`, stamp, refresh);
    indexes.set(`${product}:${hour}`, index);
  };
  for (const product of Object.keys(source.upstream.products)) await loadInventory({ hour: lastHour, product });
  const lastDuplicates: DiscoveredIndexedGribRun['duplicates'] = [];
  await checkSpecList(source, cycle, transport, indexes, indexedGribCurrentSpecs(source, lastHour), lastHour, 'current', lastDuplicates);
  const inventoryJobs = new Map<string, { hour: number; product: string }>();
  const addInventory = (hour: number, product: string) => inventoryJobs.set(`${product}:${hour}`, { hour, product });
  for (const hour of source.model.forecast.hours) {
    for (const product of Object.keys(source.upstream.products)) addInventory(hour, product);
    for (const spec of indexedGribCompanionSpecs(source, hour)) addInventory(hour - sourceIntervalHours(source.model.forecast, hour), spec.product);
  }
  let terminalFailure: { error: unknown } | undefined;
  try {
    await runConcurrent([...inventoryJobs.values()].filter(({ hour, product }) => !indexes.has(`${product}:${hour}`)), 8, async job => {
      try { await loadInventory(job); }
      catch (error) { if (!unavailableRun(error)) terminalFailure ??= { error }; throw error; }
    });
  } catch (error) { throw terminalFailure?.error ?? error; }
  for (const hour of source.model.forecast.hours) {
    if (hour === lastHour) duplicates.push(...lastDuplicates);
    else await checkSpecList(source, cycle, transport, indexes, indexedGribCurrentSpecs(source, hour), hour, 'current', duplicates);
    if (indexedGribWindowNeedsCompanion(source, hour)) {
      await checkSpecList(source, cycle, transport, indexes, indexedGribCompanionSpecs(source, hour), hour - sourceIntervalHours(source.model.forecast, hour), 'companion', duplicates);
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

export async function discoverPrivateIndexedGribRun(source: IndexedSource, options: DiscoverIndexedGribRunOptions, stats?: IndexedGribTransportStats) {
  const r2 = await readIndexedR2Run(source, options);
  await verifyIndexedR2Objects(r2, options.signal);
  const transport = new IndexedGribTransport({ ...options, stats, r2 });
  const run = await checkRun(source, r2.cycle, transport);
  return { run, sourcePin: r2.pin };
}

export async function discoverIndexedGribRun(source: IndexedSource, options: DiscoverIndexedGribRunOptions = {}, stats?: IndexedGribTransportStats): Promise<DiscoveredIndexedGribRun> {
  if (source.privateR2) return (await discoverPrivateIndexedGribRun(source, options, stats)).run;
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
      if (!unavailableRun(error)) throw error;
      failures.push(`${cycle}: ${(error as Error).message}`);
    }
  }
  throw new IndexedGribError('run-unavailable', 'No inventory-complete Indexed GRIB primary/secondary run found', {
    candidates: recentSourceCycles(now, source.model.forecast.cycleHoursUtc, source.upstream.discoveryLagHours, source.upstream.discoveryCandidates).map(value => value.replace('.000Z', 'Z')),
    failures,
  });
}
