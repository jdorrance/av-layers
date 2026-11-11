import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { denseFixtureMask, syntheticWholeDomain } from '../../../../scripts/fixtures/whole-domain.js';
import { buildShard, createBuildPlan, readBuildPlan } from '../parallel.js';
import type { ForecastProvider } from '../provider.js';
import * as localFiles from '../local-file.js';

const product = { ...OFFLINE_PRODUCT, maxNativeZoom: 0, frameHours: [1] };
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-terrain-plan-')); roots.push(out);
  const open = vi.fn<ForecastProvider['open']>(async () => { throw new Error('fixture acquisition reached'); });
  const provider = { id: product.source.configurationId, provider: 'Synthetic', maxLevels: 3, open };
  return { out, open, provider, product, mask: denseFixtureMask(product, product.grid), cycle: '2026-06-21T00:00:00.000Z' };
}

it('requires whole-domain terrain before writing a plan or opening the provider', async () => {
  const options = await fixture();
  await expect(createBuildPlan(options)).rejects.toThrow('requires a terrain catalog or prepared terrain');
  await expect(readFile(join(options.out, 'plan.json'))).rejects.toThrow();
  expect(options.open).not.toHaveBeenCalled();
});
it('pins the serialized sparse terrain and validates its arrays before acquisition', async () => {
  const options = await fixture(), wholeDomain = await syntheticWholeDomain(options.out, product);
  await createBuildPlan({ ...options, wholeDomain });
  const plan = await readBuildPlan(join(options.out, 'plan.json'));
  expect(plan.wholeDomain.terrain).toEqual(wholeDomain.terrain);
  const read = vi.spyOn(localFiles, 'readLocalFile');
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('fixture acquisition reached');
  expect(options.open).toHaveBeenCalledOnce();
  expect(read.mock.calls.filter(([path]) => path.includes('/terrain/prepared/'))).toHaveLength(3);
});
it('fails a corrupted staged sidecar before opening weather acquisition', async () => {
  const options = await fixture(), wholeDomain = await syntheticWholeDomain(options.out, product);
  const plan = await createBuildPlan({ ...options, wholeDomain });
  const path = join(options.out, wholeDomain.terrain.key.replace('manifest.json', 'valid-0.u8'));
  const bytes = await readFile(path); bytes[0] ^= 1;
  await writeFile(path, bytes);
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('integrity mismatch');
  expect(options.open).not.toHaveBeenCalled();
});
it('rejects a changed pinned reference before opening weather acquisition', async () => {
  const options = await fixture(), wholeDomain = await syntheticWholeDomain(options.out, product);
  const plan = await createBuildPlan({ ...options, wholeDomain });
  plan.wholeDomain.terrain.sha256 = 'f'.repeat(64);
  await expect(buildShard({ ...options, plan, shard: 0 })).rejects.toThrow('recipe or source revision changed');
  expect(options.open).not.toHaveBeenCalled();
});
