import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MODEL, getProduct } from '@av/contracts/models';
import { renderedFrames, type ManifestV5 } from '@av/contracts';
import type { ApiClientMetric } from '@av/client';
import { probeApi, type ProbeReading } from './smoke-api.js';

function forecastFindings(manifest: ManifestV5, now: number): string[] {
  const findings: string[] = [], product = getProduct(manifest.model);
  if (!product) return ['unknown-product: latest forecast model is not registered'];
  const cycleAgeHours = (now - Date.parse(manifest.cycle)) / 3600000;
  const horizonHours = (Math.max(...renderedFrames(manifest).map(f => Date.parse(f.validTime))) - now) / 3600000;
  if (cycleAgeHours > product.freshness.maxCycleAgeHours) findings.push('upstream-lag: source cycle exceeds the admitted age');
  const daylightFiltered = product.capabilities.daylightFrames === 'regional-daylight';
  // Publication validates the selected frames; omitted night hours preserve source coverage.
  const coverageHours = daylightFiltered ? (product.mapEndHour ?? product.frameHours.at(-1)!) - cycleAgeHours : horizonHours;
  if (coverageHours < product.freshness.minHorizonHours) findings.push(`shrinking-horizon: less than ${product.freshness.minHorizonHours} hours of forecast remain`);
  if (horizonHours <= 0) findings.push('exhausted-horizon: no published forecast times remain');
  if (Date.parse(manifest.expiresAt) <= now) findings.push('expired-publication: retained build expired');
  return findings;
}

/** Check live serving integrity and configured forecast freshness. */
export async function monitor(baseUrl: string, model = DEFAULT_MODEL) {
  const findings: string[] = [], checkedAt = new Date().toISOString();
  const probes: Record<string, ProbeReading> = {};
  const clientRequests: Partial<Record<ApiClientMetric['route'], { count: number; retries: number; failed: number; maxElapsedMs: number }>> = {};
  let buildId: string | undefined, sourceRevision: string | undefined;
  try {
    if (!getProduct(model)) throw new Error('Unknown forecast model');
    await probeApi({ baseUrl, model, requireLive: false,
      observeProbe(route, reading) { probes[route] ??= reading; },
      observeClient({ route, attempts, outcome, elapsedMs }) {
        const totals = clientRequests[route] ??= { count: 0, retries: 0, failed: 0, maxElapsedMs: 0 };
        totals.count++;
        totals.retries += Math.max(0, attempts - 1);
        totals.failed += Number(outcome !== 'success');
        totals.maxElapsedMs = Math.max(totals.maxElapsedMs, Math.round(elapsedMs * 100) / 100);
      },
      observeManifest(manifest) {
        buildId = manifest.buildId; sourceRevision = manifest.recipe.sourceRevision;
        findings.push(...forecastFindings(manifest, Date.now()));
      }
    });
  } catch (error) { findings.push(`serving-integrity: ${String(error)}`); }
  return { version: 1, checkedAt, baseUrl, model, buildId, sourceRevision, healthy: findings.length === 0, findings, probes, clientRequests, runbook: 'docs/operations.md#check-a-failure' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseUrl = process.env.API_BASE_URL;
  if (!baseUrl) throw new Error('API_BASE_URL is required');
  const result = await monitor(baseUrl.replace(/\/+$/, ''), process.env.MODEL ?? DEFAULT_MODEL);
  await mkdir('output/health', { recursive: true });
  await writeFile('output/health/latest.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (!result.healthy) process.exitCode = 1;
}
