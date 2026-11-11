import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import type { CoverageMask } from '@av/contracts';
import { buildForecast } from '../apps/batch/src/build.js';
import type { ForecastProvider } from '../apps/batch/src/provider.js';
import { normalizedFixtureFrame } from './fixtures/normalized-provider.js';
import { denseFixtureMask, syntheticWholeDomain } from './fixtures/whole-domain.js';
import { previewBuild } from './sample-preview.js';

export async function generateOfflineFixture(out: string, now = Date.now()): Promise<string> {
  const product = OFFLINE_PRODUCT, cycle = new Date(Math.floor(now / 3600000) * 3600000).toISOString();
  const mask: CoverageMask = denseFixtureMask(product, product.grid);
  const provider: ForecastProvider = {
    id: 'synthetic-offline', provider: 'SYNTHETIC offline fixture; not weather data', maxLevels: 3,
    async open({ activeIndices }) {
      return { cycle, stats: { fixture: true, networkRequests: 0 },
        async acquire(hour) { return normalizedFixtureFrame(product.grid, activeIndices, cycle, hour, product.intervalHours); },
        async close() {}
      };
    }
  };
  return buildForecast({ out, product, mask, provider, wholeDomain: await syntheticWholeDomain(out, product), deriveOptions: { daylightOnly: false } });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, allowPositionals: false, options: { out: { type: 'string' }, 'persist-to': { type: 'string' }, port: { type: 'string' }, 'generate-only': { type: 'boolean' }, 'seed-only': { type: 'boolean' }, reseed: { type: 'boolean' } } });
  const manifestPath = await generateOfflineFixture(resolve(values.out ?? 'output/offline-fixture'));
  console.log(`SYNTHETIC fixture: ${manifestPath}`);
  console.log('No model downloads. Test sample: latitude 40, longitude -100; first-frame rain = 2.75 mm/h.');
  if (values['generate-only']) return;
  await previewBuild({ manifestPath, persistTo: resolve(values['persist-to'] ?? '.wrangler/fixture-state'), port: Number(values.port ?? 8787), fixture: true, seedOnly: values['seed-only'], reseed: values.reseed, trustedProduct: OFFLINE_PRODUCT });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(`dev: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
}
