import { INDEXED_PRODUCT } from '../../../tests/model-fixtures.js';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { MODEL_CONFIG_PATH, LIFT_RENDER_STYLE, LIFT_STEP_RENDER_STYLE, liftRenderStyle } from '@av/contracts';
import { sha256 } from './terrain/contract.js';
import { buildIdentity, readProducerSourceState } from './identity.js';
import { fixtureManifest, fixturePatch } from '../../../tests/forecast-fixture.js';
import type { RefinementInput } from './refinement/prepare.js';

it('records producer configuration edits while allowing unrelated client edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-source-state-'));
  const git = async (...args: string[]) => await promisify(execFile)('git', args, { cwd: root });
  try {
    await git('init', '--quiet');
    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{}}\n');
    await git('add', 'tsconfig.json');
    await git('-c', 'user.name=Source test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    const clean = await readProducerSourceState(root);
    expect(clean).toEqual({ revision: (await git('rev-parse', 'HEAD')).stdout.trim(), dirty: false });

    await mkdir(join(root, 'apps/preview'), { recursive: true });
    await writeFile(join(root, 'apps/preview/local.ts'), 'export const label = "local UI";\n');
    expect(await readProducerSourceState(root)).toEqual(clean);

    await writeFile(join(root, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@av/forecast":["./local-science.ts"]}}}\n');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
    await git('add', 'tsconfig.json');
    expect(await readProducerSourceState(root)).toEqual({ ...clean, dirty: true });
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('keeps unstaged configuration identity stable and pins requested terrain without changing science', async () => {
  const coverageHash = 'a'.repeat(64);
  const baseline = await buildIdentity(INDEXED_PRODUCT, coverageHash);
  expect(baseline.components.configuration).toBe(sha256(JSON.stringify({ product: INDEXED_PRODUCT, coverageHash })));
  const terrain = { key: `terrain/prepared/${'b'.repeat(64)}/manifest.json`, bytes: 100, sha256: 'c'.repeat(64), arrayBytes: 20 };
  const staged = await buildIdentity(INDEXED_PRODUCT, coverageHash, terrain);
  const different = await buildIdentity(INDEXED_PRODUCT, coverageHash, { ...terrain, sha256: 'd'.repeat(64) });
  expect(staged.recipe.hash).not.toBe(baseline.recipe.hash);
  expect(different.recipe.hash).not.toBe(staged.recipe.hash);
  expect(staged.scienceHash).toBe(baseline.scienceHash);
});

it('binds the fine terrain-column method into whole-domain science identity without regional refinements', async () => {
  const baseline = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64));
  const wholeDomain = { k: 10, nativeCoverageHash: 'b'.repeat(64), fineCoverageHash: 'c'.repeat(64), fineGridHash: 'd'.repeat(64),
    terrain: { key: `terrain/prepared/${'e'.repeat(64)}/manifest.json`, bytes: 100, sha256: 'f'.repeat(64), arrayBytes: 20 } };
  const bound = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64), undefined, [], undefined, wholeDomain);
  expect(bound.scienceHash).not.toBe(baseline.scienceHash);
  expect(bound.recipe.hash).not.toBe(baseline.recipe.hash);
});

it('pins resolved polygon, grid and DEM references while keeping the scientific method independent of the chosen region', async () => {
  const patch = fixturePatch(fixtureManifest()), coverageHash = 'a'.repeat(64);
  const input: RefinementInput = { id: patch.id, geometry: patch.geometry, bounds: patch.descriptors.bounds,
    grid: patch.grid, coverage: patch.coverage, terrain: { key: patch.terrain.key, sha256: patch.terrain.sha256, bytes: 100, arrayBytes: 45 } };
  const baseline = await buildIdentity(INDEXED_PRODUCT, coverageHash);
  const refined = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [input]);
  const changed = structuredClone(input); changed.terrain.sha256 = 'd'.repeat(64);
  const otherTerrain = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [changed]);
  if (changed.geometry.type !== 'Polygon') throw new Error('Expected polygon fixture');
  changed.geometry.coordinates[0][0][0] -= 0.001;
  changed.geometry.coordinates[0][changed.geometry.coordinates[0].length - 1][0] -= 0.001;
  const otherGeometry = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [changed]);
  expect(refined.recipe.hash).not.toBe(baseline.recipe.hash);
  expect(otherTerrain.recipe.hash).not.toBe(refined.recipe.hash);
  expect(otherGeometry.recipe.hash).not.toBe(otherTerrain.recipe.hash);
  expect(otherTerrain.scienceHash).toBe(refined.scienceHash);
  expect(otherGeometry.scienceHash).toBe(refined.scienceHash);
  expect(refined.scienceHash).not.toBe(baseline.scienceHash);
});

async function sourceFixture(interpolation: 'step' | 'linear-rgb'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'av-render-identity-')), git = promisify(execFile);
  for (const directory of ['apps/batch/src', 'packages/contracts/src', 'packages/contracts/config', 'packages/forecast/src', 'packages/soaring/src', 'packages/solar/src', 'packages/thermodynamics/src']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'packages/contracts/src/layers.ts'), `export const liftInterpolation = '${interpolation}';\n`);
  await writeFile(join(root, MODEL_CONFIG_PATH), '{}\n');
  await writeFile(join(root, 'apps/batch/pmtiles.json'), '{}\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lock\n');
  await writeFile(join(root, 'package.json'), '{}\n');
  await writeFile(join(root, 'tsconfig.json'), '{}\n');
  await git('git', ['init', '--quiet'], { cwd: root });
  await git('git', ['add', '-A'], { cwd: root });
  await git('git', ['-c', 'user.name=Source test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], { cwd: root });
  return root;
}

it('changes the render recipe for a lift interpolation source change while science identity holds', async () => {
  const step = await sourceFixture('step'), linear = await sourceFixture('linear-rgb');
  try {
    const coverageHash = 'a'.repeat(64);
    const stepIdentity = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [], step);
    const linearIdentity = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [], linear);
    expect(stepIdentity.components.contracts).not.toBe(linearIdentity.components.contracts);
    expect(stepIdentity.components.science).toBe(linearIdentity.components.science);
    expect(stepIdentity.recipe.hash).not.toBe(linearIdentity.recipe.hash);
    expect(stepIdentity.scienceHash).toBe(linearIdentity.scienceHash);
    expect(liftRenderStyle('step')).toBe(LIFT_STEP_RENDER_STYLE);
    expect(liftRenderStyle('linear-rgb')).toBe(LIFT_RENDER_STYLE);
    expect(liftRenderStyle('step')).not.toBe(liftRenderStyle('linear-rgb'));
  } finally { await Promise.all([rm(step, { recursive: true, force: true }), rm(linear, { recursive: true, force: true })]); }
});

it('keeps client source out of the recipe and pins the full workspace lockfile', async () => {
  const root = await sourceFixture('linear-rgb'), coverageHash = 'a'.repeat(64);
  try {
    const before = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [], root);
    const client = join(root, 'packages/client/src');
    await mkdir(client, { recursive: true });
    await writeFile(join(client, 'client-api.ts'), 'export const browserChange = true;\n');
    expect(await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [], root)).toEqual(before);

    const lock = 'updated workspace lockfile\n';
    await writeFile(join(root, 'pnpm-lock.yaml'), lock);
    const after = await buildIdentity(INDEXED_PRODUCT, coverageHash, undefined, [], root);
    expect(after.components).toEqual(before.components);
    expect(after.recipe.lockHash).toBe(sha256(lock));
    expect(after.recipe.hash).not.toBe(before.recipe.hash);
    expect(after.recipe.sourceDirty).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('binds global forecast settings into the recipe independently of science', async () => {
  const root = await sourceFixture('linear-rgb');
  try {
    const before = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64), undefined, [], root);
    await writeFile(join(root, MODEL_CONFIG_PATH), '{"parallelism":{"jobs":1,"workers":0}}\n');
    const after = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64), undefined, [], root);
    expect(after.components.contracts).not.toBe(before.components.contracts);
    expect(after.components.configuration).toBe(before.components.configuration);
    expect(after.recipe.hash).not.toBe(before.recipe.hash);
    expect(after.scienceHash).toBe(before.scienceHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});
