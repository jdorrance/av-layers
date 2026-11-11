import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuildOptions } from './build.js';
import { getProduct, MODEL_IDS } from '@av/contracts/models';
import { planWholeDomainGrid, type RegularLatLonGrid } from '@av/contracts';
import { BUILD_BUDGETS } from './capacity.js';

const fake = vi.hoisted(() => ({ build: vi.fn(), read: vi.fn(), storage: vi.fn() }));
vi.mock('./build.js', () => ({ buildProduct: fake.build }));
vi.mock('./local-file.js', () => ({ readLocalFile: fake.read }));
vi.mock('./storage.js', () => ({ r2Storage: fake.storage }));
import { runBatch } from './cli.js';

const catalogRef = { key: `terrain/catalogs/${'c'.repeat(64)}.json`, sha256: 'c'.repeat(64), bytes: 100 };
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fake.build.mockResolvedValue('output/manifest.json');
  fake.read.mockResolvedValue(Buffer.from(JSON.stringify(catalogRef)));
  fake.storage.mockReturnValue({});
});
afterEach(() => vi.restoreAllMocks());

it.each(['constructor', 'toString', 'unknown'])('rejects unknown command %s', async command => {
  await expect(runBatch([command])).rejects.toThrow('Usage:');
  expect(fake.build).not.toHaveBeenCalled();
});

it('passes a pinned global catalog to the build and opens one terrain store', async () => {
  await runBatch(['build', '--model', 'icon-eu', '--terrain-catalog-ref', 'catalog.json']);
  expect(fake.read).toHaveBeenCalledWith('catalog.json', 16 * 1024);
  expect(fake.storage).toHaveBeenCalledOnce();
  expect(fake.build).toHaveBeenCalledWith('icon-eu', expect.objectContaining({ wholeDomain: { catalogRef, storage: {} } }));
});

it('requires a catalog before loading a terrain store', async () => {
  await expect(runBatch(['build'])).rejects.toThrow('--terrain-catalog-ref is required');
  expect(fake.build).not.toHaveBeenCalled();
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.read).not.toHaveBeenCalled();
});

it('uses the local terrain store without constructing R2 storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'av-cli-terrain-'));
  const key = 'terrain/test.bin', bytes = Uint8Array.of(1, 2, 3);
  fake.storage.mockImplementation(() => { throw new Error('R2 must not be opened'); });
  fake.build.mockImplementationOnce(async (_model: string, { wholeDomain }: BuildOptions) => {
    if (!wholeDomain || !('catalogRef' in wholeDomain)) throw new Error('Expected a pinned catalog');
    expect(wholeDomain.catalogRef).toEqual(catalogRef);
    await wholeDomain.storage.put(key, bytes, { ifNoneMatch: '*' }, 'application/octet-stream');
    expect((await wholeDomain.storage.get(key, undefined, bytes.length))?.bytes).toEqual(Buffer.from(bytes));
    return 'output/manifest.json';
  });
  try {
    await runBatch(['build', '--terrain-catalog-ref', 'catalog.json', '--terrain-store-dir', directory]);
    expect(await readFile(join(directory, key))).toEqual(Buffer.from(bytes));
    expect(fake.storage).not.toHaveBeenCalled();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it.each([
  ['--terrain-store-dir', 'terrain'],
  ['--terrain-store-dir', '', '--terrain-catalog-ref', 'catalog.json'],
  ['--terrain-store-dir', '  ', '--terrain-catalog-ref', 'catalog.json'],
  ['--terrain-catalog-ref', '']
])('rejects unusable terrain options %j before starting work', async (...options) => {
  await expect(runBatch(['build', ...options])).rejects.toThrow(/--terrain-/);
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.build).not.toHaveBeenCalled();
  expect(fake.read).not.toHaveBeenCalled();
});

it('rejects the retired native-grid terrain option', async () => {
  await expect(runBatch(['build', '--terrain-ref', 'prepared.json'])).rejects.toThrow('Unknown option');
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.build).not.toHaveBeenCalled();
});

it('rejects malformed catalog metadata before opening storage or starting a build', async () => {
  fake.read.mockResolvedValue(Buffer.from('{}'));
  await expect(runBatch(['build', '--terrain-catalog-ref', 'catalog.json'])).rejects.toThrow();
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.build).not.toHaveBeenCalled();
});

it.each(['terrain-catalog-ref', 'terrain-store-dir'])('accepts %s only for the build command', async option => {
  await expect(runBatch(['capacity', `--${option}`, 'terrain'])).rejects.toThrow(/command-specific options/);
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.storage).not.toHaveBeenCalled();
});

it.each(MODEL_IDS)('reports configured %s whole-domain capacity without a terrain store', async model => {
  const { readLocalFile } = await vi.importActual<typeof import('./local-file.js')>('./local-file.js');
  fake.read.mockImplementation(readLocalFile);
  await runBatch(['capacity', '--model', model]);
  const report = JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string);
  const product = getProduct(model)!, plan = planWholeDomainGrid(product.grid as RegularLatLonGrid, product.terrainSubdivisionFactor!);
  expect(report).toMatchObject({ mode: 'whole-domain', model, k: product.terrainSubdivisionFactor });
  expect(report.fineGrid).toEqual(plan.fine);
  expect(report.capacity.workingSet.terrain).toBeGreaterThan(0);
  expect(report.capacity.workingSet.nativeFields).toBeGreaterThan(0);
  expect(report.capacity.workingSet.shardAssembly).toBeGreaterThan(0);
  expect(report.capacity.violations).toEqual([]);
  expect(report.violations).toEqual([]);
  expect(report.retention).toEqual({ cadenceHours: 6, retentionDays: 7, retainedPerModel: 28,
    retentionBasis: 'schedule', retainedNumericBytes: 28 * report.capacity.numericBytes });
  expect(report.capacity.tiles).toBeGreaterThan(0);
  expect(report.capacity.tiles).toBeLessThanOrEqual(BUILD_BUDGETS.tiles);
  expect(report.capacity.estimatedPeakBytes).toBeLessThanOrEqual(BUILD_BUDGETS.peakRssBytes);
  for (const count of [report.capacity.rasterWorkers, report.capacity.deriveWorkers]) {
    expect(count).toBeGreaterThanOrEqual(0);
    expect(count).toBeLessThanOrEqual(product.execution.workers);
  }
  expect(fake.storage).not.toHaveBeenCalled();
});

it('accepts retention overrides and rejects geometry overrides for whole-domain capacity reports', async () => {
  const { readLocalFile } = await vi.importActual<typeof import('./local-file.js')>('./local-file.js');
  fake.read.mockImplementation(readLocalFile);
  await runBatch(['capacity', '--model', 'rrfs', '--cadence-hours', '12', '--retention-days', '3']);
  const report = JSON.parse(vi.mocked(console.log).mock.lastCall![0] as string);
  expect(report.retention).toEqual({ cadenceHours: 12, retentionDays: 3, retainedPerModel: 6,
    retentionBasis: 'cadence-override', retainedNumericBytes: 6 * report.capacity.numericBytes });
  await expect(runBatch(['capacity', '--model', 'gfs', '--frames', '2'])).rejects.toThrow('Unknown option');
  expect(fake.storage).not.toHaveBeenCalled();
});
