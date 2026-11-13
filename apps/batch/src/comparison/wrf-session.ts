/** Pin WRF and baseline builds, reuse the AV archive, and replay matched-time scorecards. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import z from 'zod';
import { layerIdSchema, manifestV5Schema, type ManifestV5 } from '@av/contracts';
import { readLocalFile } from '../local-file.js';
import { captureUrl, readCapture, MissingCaptureError, type Capture } from './archive.js';
import { normalizeAvSamples, planAvSampleRequests } from './av-layers.js';
import { parseSites } from './sites.js';
import { buildReport } from './report.js';
import { readComparisonAnalysis } from './session.js';
import { observationScorecard } from './wrf-scorecard.js';
import type { ComparisonSample, ParameterMapping } from './core.js';

const runSchema = z.object({ model: z.string().min(1), buildId: z.string().min(1),
  // WRF publication origin follows spin-up; the run lock owns the actual forcing cycle.
  runLock: z.object({ model_id: z.string(), publish_origin_utc: z.iso.datetime(), forcing_cycle_utc: z.iso.datetime(),
    config_sha256: z.string().regex(/^[a-f0-9]{64}$/), forcing_profile_id: z.string().min(1), attempt_id: z.string().min(1),
    wrf_init_utc: z.iso.datetime(), spinup_hours: z.number().int().min(6) }).optional(),
  readyReceipt: z.string().optional() });
const selectionSchema = z.object({ forcing_profile: z.string().min(1), baseline_model: z.string(), products: z.array(z.string()).length(2),
  layers: z.array(layerIdSchema).min(1), sites: z.unknown() });
const buildSchema = runSchema.omit({ readyReceipt: true }).extend({
  manifestId: z.string().min(1), url: z.url(), sourceCycle: z.iso.datetime(),
  readySha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), provenanceId: z.string().optional()
});
const requestSchema = z.object({ id: z.string().min(1), build: z.number().int().min(0).max(2), av: z.object({
  url: z.url(), sites: z.array(z.object({ id: z.string(), lat: z.number().finite(), lon: z.number().finite() })).min(1).max(256),
  frameIds: z.array(z.string()).min(1).max(1024), layers: z.array(layerIdSchema).min(1).max(64)
}) });
const planSchema = z.object({ version: z.literal(1), baseline: z.string().min(1),
  forcingProfile: z.string().min(1), sites: z.unknown().transform(parseSites),
  layers: z.array(layerIdSchema).min(1).max(64), builds: z.array(buildSchema).length(3),
  requests: z.array(requestSchema).min(1).max(4096), referenceTime: z.iso.datetime(), api: z.url()
});
type Build = z.infer<typeof buildSchema>;
type Plan = z.infer<typeof planSchema>;
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

// Keep failed HTTP responses immutable while allowing a later invocation to resume collection.
async function successfulCapture(archive: string, baseId: string, url: string, collect: boolean) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const id = attempt ? `${baseId}-retry-${attempt}` : baseId;
    let capture: Capture;
    try { capture = await readCapture(archive, id, { url, method: 'GET' }); }
    catch (error) {
      if (!collect || !(error instanceof MissingCaptureError)) throw error;
      capture = await captureUrl(archive, id, url);
      if (capture.status !== 200) throw new Error(`HTTP ${capture.status}: ${url}; rerun to retry`);
    }
    if (capture.status === 200) return { id, capture };
  }
  throw new Error(`Capture retry budget exhausted: ${baseId}`);
}

export async function planWrfComparison(out: string, options: { campaign: string; runs: string; api: string; reference: string }) {
  const campaign = selectionSchema.parse(await readJson(options.campaign)), sites = parseSites(campaign.sites);
  const runs = z.array(runSchema).length(3).parse(await readJson(options.runs));
  const models = [campaign.baseline_model, ...campaign.products];
  if (new Set(models).size !== 3 || [...runs.map(run => run.model)].sort().join() !== [...models].sort().join()) throw new Error('Select exactly the campaign models');
  const referenceTime = z.iso.datetime().parse(options.reference), archive = join(out, 'captures');
  const plan: Plan = { version: 1, baseline: campaign.baseline_model, forcingProfile: campaign.forcing_profile, sites, layers: campaign.layers, builds: [], requests: [], referenceTime, api: options.api };
  const manifests: ManifestV5[] = [];
  for (const [index, run] of runs.entries()) {
    const url = new URL(`/v1/models/${encodeURIComponent(run.model)}/runs/${encodeURIComponent(run.buildId)}`, options.api).href;
    const { id: manifestId, capture } = await successfulCapture(archive, `manifest-${index}`, url, true);
    const manifest = admittedManifest(payload(capture), run.model, run.buildId);
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
  plan.requests = plannedRequests(plan, manifests);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'wrf-plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

async function bindWrfRun(archive: string, index: number, url: string, manifest: ManifestV5, run: z.infer<typeof runSchema>) {
  if (!run.readyReceipt || !run.runLock) throw new Error('WRF requires --runs readyReceipt path and runLock');
  const bytes = await readLocalFile(run.readyReceipt, 4 * 1024 ** 2), readySha256 = digest(bytes.toString());
  const { id: provenanceId, capture: provenance } = await successfulCapture(archive, `provenance-${index}`,
    `${url}/provenance?frame=${encodeURIComponent(manifest.frames[0].id)}`, true);
  verifyReceipt(bytes, payload(provenance), run.runLock, run.model, run.buildId);
  const path = join(archive, `ready-${index}.json`);
  try { await writeFile(path, bytes, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (!(await readLocalFile(path, 4 * 1024 ** 2)).equals(bytes)) throw new Error('Archived ready receipt changed');
  }
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

function plannedRequests(plan: Plan, manifests: ManifestV5[]): Plan['requests'] {
  const models = plan.builds.map(build => build.model);
  if (new Set(models).size !== 3 || !models.includes(plan.baseline)) throw new Error('Unique models and baseline required');
  if (new Set(plan.layers).size !== plan.layers.length) throw new Error('Duplicate campaign layers');
  if (new Set(plan.builds.map(build => new Date(build.sourceCycle).toISOString())).size !== 1) throw new Error('Matched source cycles required');
  const science = manifests.map(manifest => z.object({ science: z.string().regex(/^[a-f0-9]{64}$/) }).parse(manifest.tool.components).science);
  if (new Set(science).size !== 1) throw new Error('Consumer science versions differ');
  for (const [index, manifest] of manifests.entries()) {
    const build = plan.builds[index], lock = build.runLock;
    if (manifest.model !== build.model || manifest.buildId !== build.buildId) throw new Error('Pinned manifest identity differs');
    if (Date.parse(manifest.createdAt) > Date.parse(plan.referenceTime)) throw new Error('Build was created after briefing cutoff');
    if (build.model !== plan.baseline) {
      if (!lock || lock.forcing_profile_id !== plan.forcingProfile) throw new Error('WRF forcing profile differs from campaign');
      if (Date.parse(lock.wrf_init_utc) + lock.spinup_hours * 3600000 !== Date.parse(lock.publish_origin_utc)
        || Date.parse(lock.forcing_cycle_utc) > Date.parse(lock.wrf_init_utc)) throw new Error('Inconsistent WRF initialization clocks');
    }
    for (const layer of plan.layers) {
      const descriptor = manifest.descriptors.layers[layer], baseline = manifests[0].descriptors.layers[layer];
      if (!manifest.layers.includes(layer) || !descriptor || !baseline
        || descriptor.units !== baseline.units || descriptor.timeSupport !== baseline.timeSupport
        || descriptor.verticalReference !== baseline.verticalReference
        || descriptor.methodId !== baseline.methodId
        || !isDeepStrictEqual(manifest.descriptors.methods[descriptor.methodId].parameters, manifests[0].descriptors.methods[baseline.methodId].parameters)) {
        throw new Error('Consumer layer methods or conventions differ');
      }
    }
  }
  const common = manifests[0].frames.map(frame => Date.parse(frame.validTime)).filter(time =>
    manifests.every(manifest => manifest.frames.some(frame => Date.parse(frame.validTime) === time)));
  const wrf = plan.builds.flatMap((build, index) => build.model === plan.baseline ? [] : [index]);
  const clocks = wrf.map(index => {
    const lock = plan.builds[index].runLock!;
    return [Date.parse(lock.wrf_init_utc), lock.spinup_hours, Date.parse(lock.publish_origin_utc)];
  });
  if (!isDeepStrictEqual(clocks[0], clocks[1])) throw new Error('WRF spin-up clocks differ');
  const wrfTimes = wrf.map(index => manifests[index].frames.map(frame => Date.parse(frame.validTime)));
  if (!isDeepStrictEqual(wrfTimes[0], wrfTimes[1])) throw new Error('WRF valid-time horizons differ');
  if (!common.length) throw new Error('Builds have no common valid times');
  const requests: Plan['requests'] = [];
  for (const [index, manifest] of manifests.entries()) {
    const frames = manifest.frames.filter(frame => common.includes(Date.parse(frame.validTime))).map(frame => frame.id);
    for (const av of planAvSampleRequests({ ...manifest, layers: plan.layers }, plan.sites, { baseUrl: plan.api, frames })) {
      requests.push(requestSchema.parse({ id: `samples-${requests.length}`, build: index, av }));
    }
  }
  return requests;
}

async function readPlan(out: string) {
  const plan = planSchema.parse(await readJson(join(out, 'wrf-plan.json'))), archive = join(out, 'captures');
  const builds = await Promise.all(plan.builds.map((build, index) => replayBuild(archive, build, index, plan.baseline)));
  if (!isDeepStrictEqual(plan.requests, plannedRequests(plan, builds.map(build => build.manifest)))) {
    throw new Error('Archived requests differ from the complete comparison plan');
  }
  return { plan, archive, builds };
}

export async function captureWrfComparison(out: string) {
  const { plan, archive } = await readPlan(out);
  for (const request of plan.requests) await successfulCapture(archive, request.id, request.av.url, true);
  return { requests: plan.requests.length };
}

export async function reportWrfComparison(out: string, observationPath?: string) {
  const { plan, archive, builds } = await readPlan(out);
  const manifests = builds.map(build => build.manifest), samples: ComparisonSample[] = [];
  const availability = builds.map(({ manifest, capturedAt }) => ({ model: manifest.model,
    createdAt: manifest.createdAt, firstSeenAt: capturedAt, samplesCapturedAt: capturedAt, observedByBriefing: false }));
  for (const request of plan.requests) {
    const { id, capture } = await successfulCapture(archive, request.id, request.av.url, false);
    if (Date.parse(capture.capturedAt) > Date.parse(availability[request.build].samplesCapturedAt)) availability[request.build].samplesCapturedAt = capture.capturedAt;
    samples.push(...normalizeAvSamples(manifests[request.build], request.av, payload(capture), id));
  }
  for (const item of availability) item.observedByBriefing = Date.parse(item.samplesCapturedAt) <= Date.parse(plan.referenceTime);
  const merged = mergeSamples(samples), baseline = merged.filter(sample => sample.model === plan.baseline);
  const mappings: ParameterMapping[] = plan.layers.map(layer => ({ id: layer, leftParameter: layer, rightParameter: layer,
    comparability: 'equivalent', note: 'Same published layer; native grids and atmosphere differ.' }));
  const differences = Object.fromEntries(plan.builds.filter(build => build.model !== plan.baseline).map(build => [build.model,
    buildReport(merged.filter(sample => sample.model === build.model), baseline, mappings, plan.sites,
      { pairing: { mode: 'products-at-valid-time', note: 'Matched forcing cycles; WRF publication origin follows spin-up.' } })]));
  const observations = observationPath ? await readLocalFile(observationPath, 16 * 1024 ** 2) : undefined;
  const validTimes = [...new Set(merged.map(sample => new Date(sample.validTime).toISOString()))].sort();
  const sampling = { validTimes, unpairedValidTimes: Object.fromEntries(manifests.map(manifest => [manifest.model,
    manifest.frames.map(frame => new Date(frame.validTime).toISOString()).filter(time => !validTimes.includes(time))])),
    qualification: 'Common valid times only; the baseline cadence can omit late WRF hours. No temporal interpolation.' };
  const report = { version: 1, referenceTime: plan.referenceTime, builds: plan.builds, availability, sampling, differences,
    cycleQualification: 'Receipt hashes bind model/attempt/configuration. Forcing clocks use internally validated operator-supplied run locks.',
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
