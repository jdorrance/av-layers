import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { manifestV5Schema } from '@av/contracts';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { generateOfflineFixture } from '../dev-fixture.js';

export async function offlinePreviewFixture() {
  const root = await mkdtemp(join(tmpdir(), 'av-offline-base-'));
  // 06:00 UTC exercises the analytic fixture during North American nighttime.
  const dayMs = 86_400_000, shiftedNow = Date.now() - 6 * 3_600_000;
  const night = Math.floor(shiftedNow / dayMs) * dayMs + 6 * 3_600_000;
  let manifestPath: string;
  try { manifestPath = relative(root, await generateOfflineFixture(root, night)); }
  catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  async function at(target: string) {
    const path = join(target, manifestPath), manifest = manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8')));
    const native = manifest.surfaces.find(surface => surface.kind === 'native')!;
    const fine = manifest.surfaces.find(surface => surface.kind === 'fine')!;
    return { root: target, manifestPath: path, manifest, native, fine, persistTo: join(target, 'state'),
      pointerKey: `catalog/${manifest.model}/latest.json`, trustedProduct: OFFLINE_PRODUCT };
  }
  return {
    dispose: () => rm(root, { recursive: true, force: true }),
    async copy() {
      const target = await mkdtemp(join(tmpdir(), 'av-local-preview-'));
      try {
        await cp(root, target, { recursive: true });
        return { ...await at(target), dispose: () => rm(target, { recursive: true, force: true }) };
      } catch (error) {
        await rm(target, { recursive: true, force: true });
        throw error;
      }
    }
  };
}
