import { afterEach, beforeEach, expect, it, vi } from 'vitest';

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

it('passes a pinned global catalog to the build and opens one terrain store', async () => {
  await runBatch(['build', '--model', 'icon-eu', '--terrain-catalog-ref', 'catalog.json']);
  expect(fake.read).toHaveBeenCalledWith('catalog.json', 16 * 1024);
  expect(fake.storage).toHaveBeenCalledOnce();
  expect(fake.build).toHaveBeenCalledWith('icon-eu', expect.objectContaining({ refinement: { catalogRef, storage: {} } }));
});

it('does not construct terrain storage when no catalog was supplied', async () => {
  await runBatch(['build']);
  expect(fake.build).toHaveBeenCalledWith('gfs', { out: 'output', cycle: undefined, cacheDir: undefined });
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.read).not.toHaveBeenCalled();
});

it('preserves the staged native-grid terrain option without remote storage', async () => {
  const terrain = { key: `terrain/prepared/${'a'.repeat(64)}/manifest.json`, sha256: 'b'.repeat(64), bytes: 100, arrayBytes: 20 };
  fake.read.mockResolvedValue(Buffer.from(JSON.stringify(terrain)));
  await runBatch(['build', '--terrain-ref', 'prepared.json']);
  expect(fake.build).toHaveBeenCalledWith('gfs', expect.objectContaining({ terrain }));
  expect(fake.storage).not.toHaveBeenCalled();
});

it('rejects malformed catalog metadata before opening storage or starting a build', async () => {
  fake.read.mockResolvedValue(Buffer.from('{}'));
  await expect(runBatch(['build', '--terrain-catalog-ref', 'catalog.json'])).rejects.toThrow();
  expect(fake.storage).not.toHaveBeenCalled();
  expect(fake.build).not.toHaveBeenCalled();
});

it('accepts catalog preparation only for the build command', async () => {
  await expect(runBatch(['capacity', '--terrain-catalog-ref', 'catalog.json'])).rejects.toThrow(/command-specific options/);
  expect(fake.read).not.toHaveBeenCalled();
  expect(fake.storage).not.toHaveBeenCalled();
});
