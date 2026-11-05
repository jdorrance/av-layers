import { INDEXED_PRODUCT, SPLIT_PRODUCT } from '../../../tests/model-fixtures';
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { MAX_SAMPLE_RANGE_BYTES, encodeSparseCoverage, type ForecastSurfaceV5, type ProductDefinition } from '@av/contracts';
import { planSample, planShardedPackedSample, prepareShardedSamplePackLayout } from '@av/forecast';
import { describeSparseCoverage, loadCoverage } from '../../batch/src/coverage';
import { loadBundledFineCoverage, nativeSparseMask, wholeDomainPlan } from '../../batch/src/whole-domain/coverage';
import { coverageMemory, resolveSparseCoverage } from '../src/coverage';
import { inFlightAllocationBytes, ResourceLimitError } from '../src/resources';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fixture(product: ProductDefinition, native = false) {
  const fine = native ? undefined : await loadBundledFineCoverage(product, wholeDomainPlan(product)!);
  const mask = fine?.mask ?? nativeSparseMask(await loadCoverage(product));
  const description = fine ?? describeSparseCoverage(mask, product);
  const sparse = encodeSparseCoverage(mask.coverage), channels = product.frameHours.length * (native ? 1 : 2);
  const layout = prepareShardedSamplePackLayout(mask.grid, mask.coverage.blockIds, channels);
  const hash = description.hash, prefix = `coverage/${hash}`;
  const surface: ForecastSurfaceV5 = {
    id: native ? 'native' : 'fine', kind: native ? 'native' : 'fine', grid: mask.grid, gridHash: description.descriptor.gridHash,
    coverage: { id: product.coverageId, hash, maskKey: `${prefix}/manifest.json`, maxZoom: product.maxNativeZoom, gridHash: description.descriptor.gridHash },
    layers: native ? ['precip-rate'] : ['usable-lift-msl', 'usable-lift-agl'],
    samples: { format: 'cell-major-block-shards-v1', blockSize: 16, channelOrder: 'frame-then-layer', channelCount: channels,
      coverageHash: hash, blockCount: layout.blockCount, storedCells: layout.storedCells,
      shards: layout.shards.map((shard, i) => ({ firstBlock: shard.firstBlock, blockCount: shard.blockCount, storedCells: shard.byteLength / (channels * 5), bytes: shard.byteLength, key: `shard-${i}`, sha256: 'a'.repeat(64) })) }
  };
  return { surface, descriptor: description.descriptor, bytes: description.bytes, sparse, tiles: mask.tiles, layout };
}

it('retains both current fine masks and native coverage within the cache budget', async () => {
  const fixtures = await Promise.all([fixture(INDEXED_PRODUCT), fixture(SPLIT_PRODUCT), fixture(INDEXED_PRODUCT, true)]);
  const objects = new Map<string, Uint8Array>();
  for (const item of fixtures) {
    const prefix = `coverage/${item.surface.coverage.hash}`;
    objects.set(`${prefix}/manifest.json`, item.bytes); objects.set(`${prefix}/sparse.bin`, item.sparse); objects.set(`${prefix}/tiles.bin`, item.tiles);
  }
  let reads = 0;
  const bucket = { get: async (key: string) => {
    reads++;
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
  } } as unknown as R2Bucket;
  const receipts = [];
  for (const item of fixtures) {
    const grid = item.surface.grid;
    if (grid.kind !== 'regular-latlon') throw new Error('Expected regular grid');
    let ordinal = 0, block = item.layout.block(ordinal);
    while ((block.width !== 17 || block.height !== 17) && ++ordinal < item.layout.blockCount) block = item.layout.block(ordinal);
    expect(block.width).toBe(17); expect(block.height).toBe(17);
    const sample = planSample(grid, grid.lat0 + (block.row + 15.5) * grid.dy, grid.lon0 + (block.column + 15.5) * grid.dx)!;
    const plan = planShardedPackedSample(item.layout, sample, Array.from({ length: item.surface.samples.channelCount }, (_, i) => i));
    expect(plan.byteRange.length).toBe(19 * item.surface.samples.channelCount * 5);
    expect(plan.byteRange.length).toBeLessThanOrEqual(MAX_SAMPLE_RANGE_BYTES);
    const start = performance.now(), lease = await resolveSparseCoverage(bucket, item.surface, undefined, item.descriptor.bounds);
    receipts.push({ blocks: lease.coverage.layout.blockCount, sparseBytes: item.sparse.byteLength, maxRangeBytes: plan.byteRange.length, coldMs: Math.round(performance.now() - start), ...coverageMemory(bucket) });
    lease.release();
  }
  const coldReads = reads;
  for (const item of fixtures) {
    const start = performance.now(), lease = await resolveSparseCoverage(bucket, item.surface, undefined, item.descriptor.bounds);
    receipts.push({ blocks: lease.coverage.layout.blockCount, warmMs: Math.round(performance.now() - start), ...coverageMemory(bucket) });
    lease.release();
  }
  expect(reads).toBe(coldReads);
  expect(coverageMemory(bucket).cachedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  expect(coverageMemory(bucket).leasedBytes).toBe(0);
  console.log('full coverage receipts', JSON.stringify(receipts));
  let peakCold = 0;
  const concurrent = { get: async (key: string) => {
    peakCold = Math.max(peakCold, inFlightAllocationBytes());
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
  } } as unknown as R2Bucket;
  const concurrentLeases = await Promise.all(fixtures.slice(0, 2).map(item => resolveSparseCoverage(concurrent, item.surface, undefined, item.descriptor.bounds)));
  for (const lease of concurrentLeases) lease.release();
  expect(peakCold).toBeLessThanOrEqual(32 * 1024 * 1024);
  expect(coverageMemory(concurrent).leasedBytes).toBe(0);
  console.log('concurrent cold coverage receipt', JSON.stringify({ peakReservedBytes: peakCold, ...coverageMemory(concurrent) }));
}, 120_000);

it('bounds rotating retained masks and coalesces leases until delayed reads settle', async () => {
  const item = await fixture(INDEXED_PRODUCT), objects = new Map<string, Uint8Array>();
  const surfaces = Array.from({ length: 8 }, (_, i) => {
    const bytes = new TextEncoder().encode(JSON.stringify({ ...item.descriptor, policy: `rotation-${i}` })), hash = digest(bytes), prefix = `coverage/${hash}`;
    objects.set(`${prefix}/manifest.json`, bytes); objects.set(`${prefix}/sparse.bin`, item.sparse); objects.set(`${prefix}/tiles.bin`, item.tiles);
    return { ...item.surface, coverage: { ...item.surface.coverage, hash, maskKey: `${prefix}/manifest.json` }, samples: { ...item.surface.samples, coverageHash: hash } };
  });
  const gates: (() => void)[] = [];
  let peakReserved = 0;
  const bucket = { get: async (key: string) => {
    peakReserved = Math.max(peakReserved, inFlightAllocationBytes());
    if (key.startsWith('range-')) {
      await new Promise<void>(resolve => { gates.push(resolve); });
      return { size: 1, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Uint8Array.of(0)); controller.close(); } }) };
    }
    const bytes = objects.get(key);
    return bytes ? { size: bytes.length, body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) } : null;
  } } as unknown as R2Bucket;
  const first = await resolveSparseCoverage(bucket, surfaces[0]);
  const charged = coverageMemory(bucket).leasedBytes;
  const same = await resolveSparseCoverage(bucket, surfaces[0]);
  expect(coverageMemory(bucket).leasedBytes).toBe(charged);
  same.release();
  const leases = [first];
  const requests: Promise<void>[] = [];
  const delay = (lease: typeof first) => {
    requests.push((async () => { try { await bucket.get(`range-${requests.length}`, { range: { offset: 0, length: 1 } }); } finally { lease.release(); } })());
  };
  delay(first);
  let peak = charged, rejected = false;
  try {
    for (const surface of surfaces.slice(1)) {
      try { const lease = await resolveSparseCoverage(bucket, surface); leases.push(lease); delay(lease); }
      catch (error) { expect(error).toBeInstanceOf(ResourceLimitError); rejected = true; break; }
      peak = Math.max(peak, coverageMemory(bucket).leasedBytes);
      expect(coverageMemory(bucket).cachedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
      expect(coverageMemory(bucket).leasedBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    }
    expect(rejected).toBe(true);
    expect(leases.length).toBeGreaterThan(1);
    const again = await resolveSparseCoverage(bucket, surfaces[0]);
    expect(again.coverage.mask).toBe(first.coverage.mask);
    expect(coverageMemory(bucket).leasedBytes).toBe(peak);
    again.release();
  } finally { for (const gate of gates) gate(); await Promise.all(requests); }
  expect(coverageMemory(bucket).leasedBytes).toBe(0);
  expect(peakReserved).toBeLessThanOrEqual(32 * 1024 * 1024);
  console.log('rotating coverage receipt', JSON.stringify({ held: leases.length, peakLeasedBytes: peak, peakReservedBytes: peakReserved, ...coverageMemory(bucket) }));
}, 120_000);
