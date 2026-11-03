import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { GFS_PRODUCT, manifestSchema, setBit, type CoverageMask, type Manifest, type ProductDefinition, type RefinementPatch } from '@av/contracts';
import { prepareSamplePackLayout } from '@av/forecast';
import { normalizedFixtureFrame } from '../../../../scripts/fixtures/normalized-provider.js';
import { fixturePatch } from '../../../../tests/forecast-fixture.js';
import { buildForecast } from '../build.js';
import { writeCoverage } from '../coverage.js';
import type { ForecastProvider } from '../provider.js';
import { createSamplePackBuilder } from '../sample-pack.js';
import { assertValidatedBuild, localPath, validateBuild } from '../validate.js';

// Exercise real pixels, encoding, archives and validation with one inline tile.
vi.mock('../raster-pool.js', async importOriginal => ({
  ...await importOriginal<typeof import('../raster-pool.js')>(), rasterWorkerCount: () => 0
}));

const cycle = '2026-06-21T12:00:00.000Z';
const product: ProductDefinition = {
  ...GFS_PRODUCT, modelId: 'refinement-fixture', id: 'refinement-fixture-recipe',
  coverageId: 'refinement-fixture-coverage', coverageDescription: 'Synthetic bounded validation grid',
  bounds: [-1, -1, 1, 1], maxNativeZoom: 0, frameHours: [1], intervalHours: 1, layers: ['usable-lift-agl'],
  grid: { kind: 'regular-latlon', width: 3, height: 3, earthRadiusM: 6371229, lon0: -1, lat0: 1, dx: 1, dy: -1, wrapLongitude: false }
};
const baseMask: CoverageMask = { grid: product.grid, bounds: product.bounds, maxZoom: 0, output: Uint8Array.of(255, 1), halo: new Uint8Array(2), tiles: Uint8Array.of(1) };
const provider: ForecastProvider = {
  id: product.source.configurationId, provider: 'Synthetic validation fixture', maxLevels: 3,
  async open({ activeIndices }) {
    return { cycle, stats: { networkRequests: 0 },
      async acquire(hour) { return normalizedFixtureFrame(product.grid, activeIndices, cycle, hour, product.intervalHours); },
      async close() {}
    };
  }
};

let root: string, manifest: Manifest, fineMask: CoverageMask;
async function writeFineCoverage(mask: CoverageMask, patch: RefinementPatch): Promise<void> {
  const hash = await writeCoverage(root, mask, { coverageId: patch.coverage.id, coverageDescription: 'Synthetic interior with complete interpolation halo', bounds: patch.descriptors.bounds, supportHaloCells: 1 });
  patch.coverage = { ...patch.coverage, hash, maskKey: `coverage/${hash}/manifest.json` };
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'av-refinement-validation-'));
  const path = await buildForecast({ out: root, product, mask: baseMask, provider, cycle });
  const base = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8'))), patch = fixturePatch(base);
  fineMask = { grid: patch.grid, bounds: patch.descriptors.bounds, maxZoom: 0, output: new Uint8Array(2), halo: Uint8Array.of(255, 1), tiles: Uint8Array.of(1) };
  setBit(fineMask.output, 4); setBit(fineMask.halo, 4, false);
  await writeFineCoverage(fineMask, patch);
  const layout = prepareSamplePackLayout(fineMask.grid, fineMask.output, fineMask.halo), pack = createSamplePackBuilder(layout, 1);
  try {
    pack.writeChannel(0, { values: new Float32Array(9).fill(900), flags: new Uint8Array(9) });
    const result = await pack.finish(localPath(root, patch.samples.key));
    patch.samples = { ...patch.samples, storedCells: layout.storedCells, ...result };
  } finally { pack.close(); }
  // This subpixel patch hits no zoom-zero quarter samples, so the real base archive is also the composite image.
  manifest = manifestSchema.parse({ ...base, version: 4, patches: [patch] });
}, 30_000);
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }); });

it('fully validates a real version-four build with both numeric packs, coverage and PMTiles', async () => {
  const validated = await validateBuild(root, manifest, baseMask, manifest.coverage.hash, product);
  expect(validated.manifest.version).toBe(4);
  expect(validated.manifest.patches?.[0].samples.bytes).toBe(45);
  expect(() => assertValidatedBuild(root, manifest, validated)).not.toThrow();
});

it('rejects a patch descriptor bound to the wrong coverage extent', async () => {
  const changed = structuredClone(manifest);
  changed.patches![0].descriptors.bounds[2] = 0.007;
  await expect(validateBuild(root, changed, baseMask, changed.coverage.hash, product)).rejects.toThrow('Coverage descriptor binding mismatch');
});

it('checks interpolation support after verifying an honestly rehashed coverage descriptor', async () => {
  const changed = structuredClone(manifest), incomplete = { ...fineMask, halo: new Uint8Array(fineMask.halo) };
  setBit(incomplete.halo, 0, false);
  await writeFineCoverage(incomplete, changed.patches![0]);
  expect(changed.patches![0].coverage.hash).not.toBe(manifest.patches![0].coverage.hash);
  await expect(validateBuild(root, changed, baseMask, changed.coverage.hash, product)).rejects.toThrow('Refinement interpolation support is incomplete');
});

it('rejects altered fine numeric bytes even when the base build and samples remain valid', async () => {
  const path = localPath(root, manifest.patches![0].samples.key), original = await readFile(path), changed = Buffer.from(original);
  changed[0] ^= 1;
  try {
    await writeFile(path, changed);
    await expect(validateBuild(root, manifest, baseMask, manifest.coverage.hash, product)).rejects.toThrow('Invalid samples hash');
  } finally { await writeFile(path, original); }
});
