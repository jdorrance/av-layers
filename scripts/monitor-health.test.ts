import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_PRODUCT, PRODUCTS, manifestSchema, type ProductDefinition, type PublishedManifest } from '@av/contracts';
import { assertUsefulHorizon } from '../apps/batch/src/publication.js';
import { monitor } from './monitor-health.js';
import * as serving from './smoke-api.js';

const HOUR = 3600000;
function fixture(product: ProductDefinition = DEFAULT_PRODUCT, cycle = '2026-12-21T00:00:00Z', hours = product.frameHours) {
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  manifest.model = product.modelId; manifest.cycle = cycle;
  manifest.createdAt = new Date(Date.parse(cycle) + 1000).toISOString();
  manifest.expiresAt = new Date(Date.parse(cycle) + 7 * 86400000).toISOString();
  manifest.frames = hours.map(hour => ({
    id: `f${String(hour).padStart(3, '0')}`, validTime: new Date(Date.parse(cycle) + hour * HOUR).toISOString(),
    intervalStart: new Date(Date.parse(cycle) + (hour - product.intervalHours) * HOUR).toISOString(),
    intervalEnd: new Date(Date.parse(cycle) + hour * HOUR).toISOString()
  }));
  return manifest;
}
function observe(manifest: PublishedManifest, now: number) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => { options.observeManifest?.(manifest); return manifest; });
  return monitor('https://api.example', manifest.model);
}
afterEach(() => vi.restoreAllMocks());

it('keeps identity and expiry findings when a later serving probe fails', async () => {
  const manifest = fixture(); manifest.expiresAt = new Date(0).toISOString();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(manifest.cycle));
  vi.spyOn(serving, 'probeApi').mockImplementation(async options => { options.observeManifest?.(manifest); throw new Error('sample unavailable'); });
  const result = await monitor('https://api.example');
  expect(result).toMatchObject({ healthy: false, model: DEFAULT_PRODUCT.modelId, buildId: manifest.buildId, sourceRevision: manifest.recipe.sourceRevision });
  expect(result.findings.join(';')).toContain('expired-publication');
  expect(result.findings.join(';')).toContain('sample unavailable');
});

it.each(PRODUCTS)('uses configured source age, horizon and expiry for $modelId', async product => {
  const manifest = fixture(product), cycle = Date.parse(manifest.cycle);
  const deadline = cycle + Math.min(product.freshness.maxCycleAgeHours, product.frameHours.at(-1)! - product.freshness.minHorizonHours) * HOUR;
  expect((await observe(manifest, deadline)).healthy).toBe(true);
  const stale = await observe(manifest, cycle + (product.freshness.maxCycleAgeHours + product.frameHours.at(-1)! + 1) * HOUR);
  expect(stale.findings.join(';')).toContain('upstream-lag');
  expect(stale.findings.join(';')).toContain('shrinking-horizon');
  expect(stale.findings.join(';')).toContain('exhausted-horizon');
  expect(stale.findings.join(';')).not.toContain('expired-publication');
});

it.each(PRODUCTS.filter(product => product.capabilities.daylightFrames === 'regional-daylight'))('keeps $modelId daylight-filtered horizons aligned with health', async product => {
  const cycle = '2026-12-21T00:00:00Z';
  const shortened = product.frameHours.filter((_, index) => index % 2 === 0);
  for (const hours of [product.frameHours, shortened]) {
    const manifest = fixture(product, cycle, hours);
    const deadline = Math.min(
      Date.parse(cycle) + Math.min(product.freshness.maxCycleAgeHours, product.frameHours.at(-1)! - product.freshness.minHorizonHours) * HOUR,
      Date.parse(manifest.frames.at(-1)!.validTime) - 1
    );
    expect(() => assertUsefulHorizon(manifest, deadline)).not.toThrow();
    expect((await observe(manifest, deadline)).findings).toEqual([]);
    expect(() => assertUsefulHorizon(manifest, deadline + 1)).toThrow('useful forecast horizon');
    expect((await observe(manifest, deadline + 1)).healthy).toBe(false);
  }
});

it('reports an unknown model before probing', async () => {
  const probe = vi.spyOn(serving, 'probeApi');
  expect((await monitor('https://api.example', 'unknown')).findings.join(';')).toContain('Unknown forecast model');
  expect(probe).not.toHaveBeenCalled();
});
