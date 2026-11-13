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

it('binds whole-domain terrain, coverage and the lift method to their respective identities', async () => {
  const coverageHash = 'a'.repeat(64);
  const baseline = await buildIdentity(INDEXED_PRODUCT, coverageHash);
  expect(baseline.components.configuration).toBe(sha256(JSON.stringify({ product: INDEXED_PRODUCT, coverageHash })));
  const wholeDomain = { k: 10, nativeCoverageHash: coverageHash, fineCoverageHash: 'c'.repeat(64), fineGridHash: 'd'.repeat(64),
    terrain: { key: `terrain/prepared/${'e'.repeat(64)}/manifest.json`, bytes: 100, sha256: 'f'.repeat(64), arrayBytes: 20 } };
  const bound = await buildIdentity(INDEXED_PRODUCT, coverageHash, { wholeDomain });
  expect(bound.scienceHash).not.toBe(baseline.scienceHash);
  expect(bound.recipe.hash).not.toBe(baseline.recipe.hash);
  const otherTerrain = await buildIdentity(INDEXED_PRODUCT, coverageHash, { wholeDomain: { ...wholeDomain, terrain: { ...wholeDomain.terrain, sha256: 'c'.repeat(64) } } });
  const otherGrid = await buildIdentity(INDEXED_PRODUCT, coverageHash, { wholeDomain: { ...wholeDomain, fineGridHash: 'f'.repeat(64) } });
  expect(otherTerrain.recipe.hash).not.toBe(bound.recipe.hash);
  expect(otherGrid.recipe.hash).not.toBe(bound.recipe.hash);
  expect(otherTerrain.scienceHash).toBe(bound.scienceHash);
  expect(otherGrid.scienceHash).toBe(bound.scienceHash);
});

async function sourceFixture(interpolation: 'step' | 'linear-rgb'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'av-render-identity-')), git = promisify(execFile);
  for (const directory of ['apps/batch/src', 'packages/contracts/src', 'packages/contracts/config', 'packages/contracts/schemas', 'packages/forecast/src', 'packages/soaring/src', 'packages/solar/src', 'packages/thermodynamics/src']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'packages/contracts/src/layers.ts'), `export const liftInterpolation = '${interpolation}';\n`);
  await writeFile(join(root, MODEL_CONFIG_PATH), '{}\n');
  await writeFile(join(root, 'packages/contracts/schemas/wrf-zarr-v3.schema.json'), '{}\n');
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
    const stepIdentity = await buildIdentity(INDEXED_PRODUCT, coverageHash, { root: step });
    const linearIdentity = await buildIdentity(INDEXED_PRODUCT, coverageHash, { root: linear });
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
    const before = await buildIdentity(INDEXED_PRODUCT, coverageHash, { root });
    const client = join(root, 'packages/client/src');
    await mkdir(client, { recursive: true });
    await writeFile(join(client, 'client-api.ts'), 'export const browserChange = true;\n');
    expect(await buildIdentity(INDEXED_PRODUCT, coverageHash, { root })).toEqual(before);

    const lock = 'updated workspace lockfile\n';
    await writeFile(join(root, 'pnpm-lock.yaml'), lock);
    const after = await buildIdentity(INDEXED_PRODUCT, coverageHash, { root });
    expect(after.components).toEqual(before.components);
    expect(after.recipe.lockHash).toBe(sha256(lock));
    expect(after.recipe.hash).not.toBe(before.recipe.hash);
    expect(after.recipe.sourceDirty).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it.each([MODEL_CONFIG_PATH, 'packages/contracts/schemas/wrf-zarr-v3.schema.json'])('binds %s into the recipe independently of science', async path => {
  const root = await sourceFixture('linear-rgb');
  try {
    const before = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64), { root });
    await writeFile(join(root, path), '{"changed":true}\n');
    const after = await buildIdentity(INDEXED_PRODUCT, 'a'.repeat(64), { root });
    expect(after.components.contracts).not.toBe(before.components.contracts);
    expect(after.components.configuration).toBe(before.components.configuration);
    expect(after.recipe.hash).not.toBe(before.recipe.hash);
    expect(after.scienceHash).toBe(before.scienceHash);
  } finally { await rm(root, { recursive: true, force: true }); }
});
