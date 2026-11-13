/** Pin WRF and baseline builds, reuse the AV archive, and replay matched-time scorecards. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import { layerIdSchema, manifestV5Schema, type ManifestV5 } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import { captureUrl, readCapture, type Capture } from './archive.js';
import { normalizeAvSamples, planAvSampleRequests, type AvSampleRequest } from './av-layers.js';
import { parseSites, type ComparisonSite } from './sites.js';
import { buildReport } from './report.js';
import { readComparisonAnalysis } from './session.js';
import { observationScorecard } from './wrf-scorecard.js';
import type { ComparisonSample, ParameterMapping } from './core.js';

const runSchema = z.object({ model: z.string().min(1), buildId: z.string().min(1),
  // WRF publication origin follows spin-up; the run lock owns the actual forcing cycle.
  runLock: z.object({ model_id: z.string(), publish_origin_utc: z.iso.datetime(), forcing_cycle_utc: z.iso.datetime(),
    config_sha256: z.string(), forcing_profile_id: z.string(), attempt_id: z.string() }).optional(),
  readyReceipt: z.string().optional() });
const selectionSchema = z.object({ forcing_profile: z.string().min(1), baseline_model: z.string(), products: z.array(z.string()).length(2),
  layers: z.array(layerIdSchema).min(1), sites: z.unknown() });
interface Build { readySha256?: string; provenanceId?: string; model: string; buildId: string; manifestId: string; url: string; sourceCycle: string; runLock?: z.infer<typeof runSchema>['runLock'] }
interface Request { id: string; build: number; av: AvSampleRequest }
interface Plan { version: 1; baseline: string; sites: ComparisonSite[]; layers: z.infer<typeof layerIdSchema>[];
  builds: Build[]; requests: Request[]; referenceTime: string; api: string }
const payload = (capture: Capture): unknown => {
  if (capture.status !== 200) throw new Error(`HTTP ${capture.status}: ${capture.url}`);
  return JSON.parse(capture.body);
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
async function readJson(path: string) { return JSON.parse((await readLocalFile(path, 4 * 1024 ** 2)).toString('utf8')) as unknown; }
function admittedManifest(raw: unknown, model: string, buildId: string) {
  const manifest = manifestV5Schema.parse(raw);
  if (manifest.model !== model || manifest.buildId !== buildId) throw new Error('Pinned manifest identity differs');
  return manifest;
}

export async function planWrfComparison(out: string, options: { campaign: string; runs: string; api: string; reference: string }) {
  const campaign = selectionSchema.parse(await readJson(options.campaign)), sites = parseSites(campaign.sites);
  const runs = z.array(runSchema).length(3).parse(await readJson(options.runs));
  const models = [campaign.baseline_model, ...campaign.products];
  if (new Set(models).size !== 3 || [...runs.map(run => run.model)].sort().join() !== [...models].sort().join()) throw new Error('Select exactly the campaign models');
  const referenceTime = z.iso.datetime().parse(options.reference), archive = join(out, 'captures');
  const plan: Plan = { version: 1, baseline: campaign.baseline_model, sites, layers: campaign.layers, builds: [], requests: [], referenceTime, api: options.api };
  const manifests: ManifestV5[] = [];
  for (const [index, run] of runs.entries()) {
    const url = new URL(`/v1/models/${encodeURIComponent(run.model)}/runs/${encodeURIComponent(run.buildId)}`, options.api).href;
    const manifestId = `manifest-${index}`, capture = await captureUrl(archive, manifestId, url);
    const manifest = admittedManifest(payload(capture), run.model, run.buildId);
    if (Date.parse(manifest.createdAt) > Date.parse(referenceTime)) throw new Error('Build was created after briefing cutoff');
    let sourceCycle = manifest.cycle;
    let binding: { readySha256: string; provenanceId: string } | undefined;
    if (run.model !== campaign.baseline_model) {
      const lock = run.runLock;
      if (!lock || lock.model_id !== run.model || Date.parse(lock.publish_origin_utc) !== Date.parse(manifest.cycle)) throw new Error('WRF build requires its matching runLock');
      if (lock.forcing_profile_id !== campaign.forcing_profile) throw new Error('WRF forcing profile differs from campaign');
      sourceCycle = lock.forcing_cycle_utc;
      binding = await bindWrfRun(archive, index, url, manifest, run);
    }
    manifests.push(manifest);
    if (campaign.layers.some(layer => !manifest.layers.includes(layer))) throw new Error('Build lacks campaign layers');
    plan.builds.push({ model: run.model, buildId: run.buildId, manifestId, url, sourceCycle, runLock: run.runLock, ...binding });
  }
  if (new Set(plan.builds.map(build => new Date(build.sourceCycle).toISOString())).size !== 1) throw new Error('Matched source cycles required');
  const commonTimes = manifests[0].frames.map(frame => Date.parse(frame.validTime)).filter(time =>
    manifests.every(manifest => manifest.frames.some(frame => Date.parse(frame.validTime) === time)));
  if (!commonTimes.length) throw new Error('Builds have no common valid times');
  for (const [index, manifest] of manifests.entries()) {
    const frames = manifest.frames.filter(frame => commonTimes.includes(Date.parse(frame.validTime))).map(frame => frame.id);
    for (const av of planAvSampleRequests({ ...manifest, layers: campaign.layers }, sites, { baseUrl: options.api, frames })) {
      plan.requests.push({ id: `samples-${plan.requests.length}`, build: index, av });
    }
  }
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'wrf-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

async function bindWrfRun(archive: string, index: number, url: string, manifest: ManifestV5, run: z.infer<typeof runSchema>) {
  if (!run.readyReceipt || !run.runLock) throw new Error('WRF requires --runs readyReceipt path and runLock');
  const bytes = await readLocalFile(run.readyReceipt, 4 * 1024 ** 2), readySha256 = digest(bytes.toString());
  const provenanceId = `provenance-${index}`;
  const provenance = await captureUrl(archive, provenanceId, `${url}/provenance?frame=${encodeURIComponent(manifest.frames[0].id)}`);
  verifyReceipt(bytes, payload(provenance), run.runLock, run.model, run.buildId);
  await writeFile(join(archive, `ready-${index}.json`), bytes, { flag: 'wx' });
  return { readySha256, provenanceId };
}

function verifyReceipt(bytes: Buffer, provenance: unknown, lock: NonNullable<Build['runLock']>, model: string, buildId: string) {
  const receipt = z.object({ model_id: z.string(), publish_origin_utc: z.iso.datetime(), config_sha256: z.string(),
    forcing_profile_id: z.string(), attempt_id: z.string() }).parse(JSON.parse(bytes.toString()));
  if (receipt.model_id !== model || receipt.model_id !== lock.model_id || receipt.config_sha256 !== lock.config_sha256
    || receipt.forcing_profile_id !== lock.forcing_profile_id || receipt.attempt_id !== lock.attempt_id
    || Date.parse(receipt.publish_origin_utc) !== Date.parse(lock.publish_origin_utc)) throw new Error('Ready receipt differs from run lock');
  const source = z.object({ model: z.string(), buildId: z.string(), receipt: z.object({ sourcePin: z.object({ sha256: z.string(), bytes: z.number() }) }) }).parse(provenance);
  if (source.model !== model || source.buildId !== buildId || source.receipt.sourcePin.sha256 !== digest(bytes.toString())
    || source.receipt.sourcePin.bytes !== bytes.length) throw new Error('Consumer source pin differs from supplied ready receipt');
}

async function replayBuild(archive: string, build: Build, index: number, baseline: string) {
  const capture = await readCapture(archive, build.manifestId, { url: build.url });
  const manifest = admittedManifest(payload(capture), build.model, build.buildId);
  let cycle = manifest.cycle;
  if (build.model !== baseline) {
    if (!build.runLock || !build.provenanceId || !build.readySha256) throw new Error('Missing WRF receipt binding');
    const bytes = await readLocalFile(join(archive, `ready-${index}.json`), 4 * 1024 ** 2);
    if (digest(bytes.toString()) !== build.readySha256) throw new Error('Archived ready receipt changed');
    const provenance = await readCapture(archive, build.provenanceId, {
      url: `${build.url}/provenance?frame=${encodeURIComponent(manifest.frames[0].id)}` });
    verifyReceipt(bytes, payload(provenance), build.runLock, build.model, build.buildId);
    if (Date.parse(manifest.cycle) !== Date.parse(build.runLock.publish_origin_utc)) throw new Error('WRF publication origin differs');
    cycle = build.runLock.forcing_cycle_utc;
  }
  if (Date.parse(cycle) !== Date.parse(build.sourceCycle)) throw new Error('Source cycle differs from archive');
  return { manifest, capturedAt: capture.capturedAt };
}

export async function captureWrfComparison(out: string) {
  const plan = await readJson(join(out, 'wrf-plan.json')) as Plan;
  for (const request of plan.requests) await captureUrl(join(out, 'captures'), request.id, request.av.url);
  return { requests: plan.requests.length };
}

export async function reportWrfComparison(out: string, observationPath?: string) {
  const plan = await readJson(join(out, 'wrf-plan.json')) as Plan, archive = join(out, 'captures');
  const manifests: ManifestV5[] = [], samples: ComparisonSample[] = [];
  const availability = [];
  for (const [index, build] of plan.builds.entries()) {
    const { manifest, capturedAt } = await replayBuild(archive, build, index, plan.baseline);
    manifests.push(manifest);
    availability.push({ model: build.model, createdAt: manifest.createdAt, firstSeenAt: capturedAt,
      observedByBriefing: Date.parse(capturedAt) <= Date.parse(plan.referenceTime) });
  }
  for (const request of plan.requests) {
    const capture = await readCapture(archive, request.id, { url: request.av.url });
    samples.push(...normalizeAvSamples(manifests[request.build], request.av, payload(capture), request.id));
  }
  if (new Set(plan.builds.map(build => new Date(build.sourceCycle).toISOString())).size !== 1) throw new Error('Matched source cycles required');
  const merged = mergeSamples(samples), baseline = merged.filter(sample => sample.model === plan.baseline);
  const mappings: ParameterMapping[] = plan.layers.map(layer => ({ id: layer, leftParameter: layer, rightParameter: layer,
    comparability: 'equivalent', note: 'Same published layer; native grids and atmosphere differ.' }));
  const differences = Object.fromEntries(plan.builds.filter(build => build.model !== plan.baseline).map(build => [build.model,
    buildReport(merged.filter(sample => sample.model === build.model), baseline, mappings, plan.sites,
      { pairing: { mode: 'products-at-valid-time', note: 'Matched forcing cycles; WRF publication origin follows spin-up.' } })]));
  const observations = observationPath ? await readLocalFile(observationPath, 16 * 1024 ** 2) : undefined;
  const report = { version: 1, referenceTime: plan.referenceTime, builds: plan.builds, availability, differences,
    cycleQualification: 'WRF ready receipts bind supplied run locks to consumer source pins; forcing cycles match baseline initialization.',
    observations: observations ? { sha256: digest(observations.toString()),
      ...observationScorecard(merged, plan.builds.map(build => build.model), plan.baseline, JSON.parse(observations.toString())) } : null,
    analysis: await readComparisonAnalysis(), planSha256: digest(await readFile(join(out, 'wrf-plan.json'), 'utf8')) };
  await writeFile(join(out, 'wrf-normalized.json'), JSON.stringify(merged) + '\n');
  await writeFile(join(out, 'wrf-report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}

function mergeSamples(samples: ComparisonSample[]): ComparisonSample[] {
  const merged = new Map<string, ComparisonSample>();
  for (const sample of samples) {
    const key = JSON.stringify([sample.model, sample.buildId, sample.siteId, sample.validTime]);
    const previous = merged.get(key);
    if (!previous) merged.set(key, structuredClone(sample));
    else for (const [layer, value] of Object.entries(sample.values)) {
      if (previous.values[layer] && JSON.stringify(previous.values[layer]) !== JSON.stringify(value)) throw new Error('Conflicting captured layer');
      previous.values[layer] = value;
    }
  }
  return [...merged.values()];
}
