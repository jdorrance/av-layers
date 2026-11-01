import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import type { CoverageMask } from '@av/contracts';
import { buildForecast } from '../apps/batch/src/build.js';
import type { ForecastProvider } from '../apps/batch/src/providers.js';
import { normalizedFixtureFrame } from './fixtures/normalized-provider.js';
import { previewBuild } from './sample-preview.js';

export async function generateOfflineFixture(out: string, now = Date.now()): Promise<string> {
  const product = OFFLINE_PRODUCT, cycle = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
  const cells = product.grid.width * product.grid.height, tileCount = (4 ** (product.maxNativeZoom + 1) - 1) / 3;
  const output = new Uint8Array(Math.ceil(cells / 8)), tiles = new Uint8Array(Math.ceil(tileCount / 8));
  for (let i = 0; i < cells; i++) output[i >> 3] |= 1 << (i & 7);
  for (let i = 0; i < tileCount; i++) tiles[i >> 3] |= 1 << (i & 7);
  const mask: CoverageMask = { grid: product.grid, bounds: product.bounds, output, halo: new Uint8Array(output.length), tiles, maxZoom: product.maxNativeZoom };
  const provider: ForecastProvider = {
    id: 'synthetic-offline', provider: 'SYNTHETIC offline fixture; not weather data', maxLevels: 3,
    async open({ activeIndices }) {
      return { cycle, stats: { fixture: true, networkRequests: 0 },
        async acquire(hour) { return normalizedFixtureFrame(product.grid, activeIndices, cycle, hour, product.intervalHours); },
        async close() {}
      };
    }
  };
  return buildForecast({ out, product, mask, provider });
}

async function main(): Promise<void> {
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
  const manifestPath = await generateOfflineFixture(resolve(arg('out') ?? 'output/offline-fixture'));
  console.log(`SYNTHETIC fixture: ${manifestPath}`);
  console.log('No model downloads. Test sample: latitude 40, longitude -100; first-frame rain = 2.75 mm/h.');
  if (process.argv.includes('--generate-only')) return;
  await previewBuild({ manifestPath, persistTo: resolve(arg('persist-to') ?? '.wrangler/fixture-state'), port: Number(arg('port') ?? 8787), fixture: true, seedOnly: process.argv.includes('--seed-only'), reseed: process.argv.includes('--reseed') });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`dev:fixture: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
