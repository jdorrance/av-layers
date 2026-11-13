/** Plan bounded provider captures and replay archived inputs through the shared comparison core. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { manifestV5Schema, type ManifestV5 } from '@av/contracts/publication';
import { captureUrl, MissingCaptureError, readCapture, type Capture } from './archive.js';
import { normalizeAvProfile, normalizeAvSamples, planAvSampleRequests, type AvSampleRequest } from './av-layers.js';
import { normalizeXcProfile, normalizeXcRuntimes, parseXcPayload, XC_MODELS } from './xc-skies.js';
import { loadSites, parseSites, type ComparisonSite } from './sites.js';
import type { ComparisonSample } from './core.js';
import { buildReport } from './report.js';
import { COMPARISON_MAPPINGS } from './mappings.js';

type Model = keyof typeof XC_MODELS;
interface Request {
  id: string; url: string; kind: 'av-samples' | 'av-profile' | 'xc-profile'; model: Model;
  siteId?: string; buildCapture?: string; av?: AvSampleRequest;
}
export interface ComparisonPlan {
  version: 1; referenceTime: string; apiBase: string; sites: ComparisonSite[];
  runtimeUrl: string; builds: { captureId: string; model: Model; buildId: string; cycle: string; frames: string[] }[];
  requests: Request[];
}

const MAX_REQUESTS = 4096;
const json = (capture: Capture): unknown => {
  if (capture.status !== 200) throw new Error(`HTTP ${capture.status} for ${capture.url}`);
  return JSON.parse(capture.body);
};
const compactDate = (date: Date) => date.toISOString().slice(0, 10).replaceAll('-', '');
const hour = (date: Date) => date.toISOString().slice(11, 13);

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

async function sourceFiles(root: string, directory: string): Promise<string[]> {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory() ? sourceFiles(root, `${directory}/${entry.name}`)
    : entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [`${directory}/${entry.name}`] : []))).flat();
}

/** Fingerprint the local analysis and its workspace dependencies, including uncommitted edits. */
export async function readComparisonAnalysis(root = ROOT) {
  const sourcePaths = [...(await Promise.all([
    'apps/batch/src/comparison', 'packages/contracts/src', 'packages/solar/src',
    'packages/soaring/src', 'packages/thermodynamics/src'
  ].map(path => sourceFiles(root, path)))).flat(), 'apps/batch/src/local-file.ts', 'packages/forecast/src/sampler.ts'].sort();
  const dependencyPaths = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.json',
    'apps/batch/package.json', 'packages/contracts/package.json', 'packages/contracts/config/models.json',
    'packages/forecast/package.json', 'packages/solar/package.json', 'packages/soaring/package.json',
    'packages/thermodynamics/package.json'].sort();
  const hashes = async (paths: string[]) => Object.fromEntries(await Promise.all(paths.map(async path => [path, digest(await readFile(join(root, path)))])));
  const [sourceFilesHash, dependencyFilesHash] = await Promise.all([hashes(sourcePaths), hashes(dependencyPaths)]);
  const identity = { version: 1, sourceHash: digest(JSON.stringify(sourceFilesHash)), dependencyHash: digest(JSON.stringify(dependencyFilesHash)),
    runtime: { node: process.version, versions: { ...process.versions }, platform: process.platform, arch: process.arch } };
  return { ...identity, hash: digest(JSON.stringify(identity)), sourceFiles: sourceFilesHash, dependencyFiles: dependencyFilesHash };
}

function pipelineMetadata(manifest: ManifestV5) {
  const raw = manifest.tool.components;
  const components = Object.fromEntries(['science', 'adapter', 'contracts', 'configuration'].map(name => {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>)[name] : undefined;
    return [name, typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null];
  })) as Record<'science' | 'adapter' | 'contracts' | 'configuration', string | null>;
  const metadataComplete = Object.values(components).every(value => value !== null);
  const values = { methodHash: manifest.method.hash, components, lockHash: manifest.recipe.lockHash,
    useStoredMslNoLift: manifest.tool.useStoredMslNoLift ?? null };
  const signatureInput = { ...values, ...(metadataComplete ? {} : { unverifiedBuildId: manifest.buildId }) };
  return { ...values, metadataComplete, pipelineSignature: createHash('sha256').update(JSON.stringify(signatureInput)).digest('hex') };
}

async function pipelineSelection(plan: ComparisonPlan, manifests: ReadonlyMap<string, ManifestV5>, archive: string) {
  const currentPipelines = [];
  for (const model of [...new Set(plan.builds.map(build => build.model))].sort()) {
    let manifest: ManifestV5, source: 'archived-latest' | 'newest-retained-cycle';
    try {
      const latest = json(await readCapture(archive, `av-latest-${model}`, {
        url: `${plan.apiBase}/v1/models/${model}/latest?expand=manifest`
      })) as { manifest: unknown };
      manifest = manifestV5Schema.parse(latest.manifest); source = 'archived-latest';
      if (manifest.model !== model) throw new Error('Latest pipeline manifest differs from model');
    } catch (error) {
      if (!(error instanceof MissingCaptureError)) throw error;
      manifest = [...manifests.values()].filter(value => value.model === model).sort((a, b) =>
        Date.parse(b.cycle) - Date.parse(a.cycle) || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.buildId.localeCompare(b.buildId))[0]!;
      source = 'newest-retained-cycle';
    }
    currentPipelines.push({ model, buildId: manifest.buildId, cycle: manifest.cycle, source, ...pipelineMetadata(manifest) });
  }
  const current = new Map(currentPipelines.map(value => [value.model, value.pipelineSignature]));
  const buildMetadata = plan.builds.map(build => {
    const manifest = manifests.get(build.captureId)!;
    if (manifest.model !== build.model || manifest.buildId !== build.buildId || Date.parse(manifest.cycle) !== Date.parse(build.cycle)) {
      throw new Error('Archived pipeline manifest differs from planned build');
    }
    const metadata = pipelineMetadata(manifest);
    return { captureId: build.captureId, model: build.model, buildId: manifest.buildId, cycle: manifest.cycle,
      ...metadata, isCurrentPipeline: metadata.pipelineSignature === current.get(build.model) };
  });
  return { currentPipelines, buildMetadata };
}

export async function planComparison(out: string, options: { sites?: string; referenceTime?: string; apiBase?: string } = {}): Promise<ComparisonPlan> {
  const sites = await loadSites(options.sites), reference = new Date(options.referenceTime ?? Date.now());
  if (!Number.isFinite(reference.getTime())) throw new Error('Invalid comparison reference time');
  reference.setUTCMinutes(0, 0, 0);
  const apiBase = options.apiBase ?? 'https://windy-av-api-production.jdorrance.workers.dev';
  const archive = join(out, 'captures'), start = new Date(reference.getTime() - 7 * 86_400_000);
  const runtimeUrl = `https://n1.xcskies.com/runtimes/all/${compactDate(start)}${hour(start)}/288?callback=cb`;
  const before = await captureUrl(archive, 'xc-runtimes-before', runtimeUrl);
  const runtimes = normalizeXcRuntimes(parseXcPayload(before.body));
  const catalog = json(await captureUrl(archive, 'av-catalog', `${apiBase}/v1/catalog`)) as {
    models: { model: string; bounds: [number, number, number, number]; available: boolean }[] };
  const plan: ComparisonPlan = { version: 1, referenceTime: reference.toISOString(), apiBase, sites, runtimeUrl, builds: [], requests: [] };
  for (const model of Object.keys(XC_MODELS) as Model[]) {
    const product = catalog.models.find(item => item.model === model);
    if (!product?.available) continue;
    const [west, south, east, north] = product.bounds;
    const eligible = sites.filter(site => site.lat >= south && site.lat <= north && site.lon >= west && site.lon <= east);
    const runs = json(await captureUrl(archive, `av-runs-${model}`, `${apiBase}/v1/models/${model}/runs`)) as {
      retained: { buildId: string; cycle: string }[] };
    const latest = json(await captureUrl(archive, `av-latest-${model}`, `${apiBase}/v1/models/${model}/latest?expand=manifest`)) as { manifest: unknown };
    const latestManifest = manifestV5Schema.parse(latest.manifest);
    const seenCycles = new Set<number>();
    const candidates = [{ buildId: latestManifest.buildId, cycle: latestManifest.cycle }, ...runs.retained];
    for (const run of candidates) {
      const cycleMs = Date.parse(run.cycle);
      if (seenCycles.has(cycleMs)) continue;
      const sharedTimes = new Set(runtimes.filter(row => row.model === model && Date.parse(row.cycle) === cycleMs).map(row => Date.parse(row.validTime)));
      if (!sharedTimes.size && run.buildId !== latestManifest.buildId) continue;
      seenCycles.add(cycleMs);
      const captureId = `av-manifest-${model}-${run.buildId}`;
      const manifest = manifestV5Schema.parse(json(await captureUrl(archive, captureId, `${apiBase}/v1/models/${model}/runs/${run.buildId}`)));
      if (manifest.model !== model || manifest.buildId !== run.buildId || Date.parse(manifest.cycle) !== cycleMs) throw new Error('AV manifest differs from selected run');
      const frames = manifest.frames.filter(frame => run.buildId === latestManifest.buildId || sharedTimes.has(Date.parse(frame.validTime))).map(frame => frame.id);
      if (!frames.length) continue;
      plan.builds.push({ captureId, model, buildId: run.buildId, cycle: run.cycle, frames });
      for (const [index, request] of planAvSampleRequests(manifest, eligible, { baseUrl: apiBase, frames }).entries()) {
        plan.requests.push({ id: `${captureId}-samples-${index}`, url: request.url, kind: 'av-samples', model, buildCapture: captureId, av: request });
      }
      for (const site of eligible) {
        const url = new URL(`${apiBase}/v1/models/${model}/runs/${run.buildId}/profile`);
        url.search = new URLSearchParams({ lat: String(site.lat), lon: String(site.lon), frame: frames.join(','), layers: 'thermal-top-msl' }).toString();
        plan.requests.push({ id: `${captureId}-profile-${site.id}`, url: url.href, kind: 'av-profile', model, siteId: site.id, buildCapture: captureId });
      }
    }
    for (const site of eligible) for (const backdays of [5, 1]) {
      const url = new URL(`https://n1.xcskies.com/profile/${XC_MODELS[model].xcModel}/${compactDate(reference)}/${hour(reference)}/00`);
      url.search = new URLSearchParams({ lat: String(site.lat), lon: String(site.lon), backdays: String(backdays), pro: '1' }).toString();
      plan.requests.push({ id: `xc-profile-${model}-${site.id}-${backdays}`, url: url.href, kind: 'xc-profile', model, siteId: site.id });
    }
  }
  if (plan.requests.length > MAX_REQUESTS) throw new Error('Comparison request plan exceeds budget');
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'plan.json'), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
  return plan;
}

export async function readPlan(out: string): Promise<ComparisonPlan> {
  const raw = await readFile(join(out, 'plan.json'), 'utf8');
  if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Comparison plan exceeds byte budget');
  const plan = JSON.parse(raw) as ComparisonPlan;
  if (plan.version !== 1 || !Array.isArray(plan.requests) || plan.requests.length > MAX_REQUESTS || !Array.isArray(plan.builds)) throw new Error('Invalid comparison plan');
  plan.sites = parseSites(plan.sites);
  if (new Set(plan.requests.map(request => request.id)).size !== plan.requests.length) throw new Error('Duplicate capture request');
  return plan;
}

export async function captureComparison(out: string, progress: (done: number, total: number) => void = () => {}, provider = 'all') {
  if (!['all', 'av-layers', 'xcskies'].includes(provider)) throw new Error('Unknown capture provider');
  const plan = await readPlan(out), archive = join(out, 'captures');
  // Browser transports can ingest response bodies through writeCapture using this same plan.
  const transport: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const headers = new Headers(init?.headers);
    if (url.hostname.endsWith('.xcskies.com') && process.env.XC_SKIES_COOKIE) headers.set('cookie', process.env.XC_SKIES_COOKIE);
    return fetch(input, { ...init, headers, redirect: 'error' });
  };
  const requests = plan.requests.filter(request => provider === 'all' || (request.kind === 'xc-profile' ? provider === 'xcskies' : provider === 'av-layers'));
  let next = 0, done = 0;
  const worker = async () => {
    while (next < requests.length) {
      const request = requests[next++];
      await captureUrl(archive, request.id, request.url, { fetch: transport });
      progress(++done, requests.length);
    }
  };
  await Promise.all([worker(), worker()]);
  if (provider !== 'av-layers') await captureUrl(archive, 'xc-runtimes-after', plan.runtimeUrl, { fetch: transport });
}

export async function replayComparison(out: string) {
  const plan = await readPlan(out), archive = join(out, 'captures');
  const analysis = await readComparisonAnalysis();
  const beforeCapture = await readCapture(archive, 'xc-runtimes-before', { url: plan.runtimeUrl });
  const afterCapture = await readCapture(archive, 'xc-runtimes-after', { url: plan.runtimeUrl });
  if (beforeCapture.status !== 200 || afterCapture.status !== 200) throw new Error('XC runtime snapshots require successful HTTP responses');
  const beforeTime = Date.parse(beforeCapture.capturedAt), afterTime = Date.parse(afterCapture.capturedAt);
  if (beforeTime > afterTime) throw new Error('XC runtime snapshot capture times are reversed');
  const before = normalizeXcRuntimes(parseXcPayload(beforeCapture.body));
  const after = normalizeXcRuntimes(parseXcPayload(afterCapture.body));
  const manifests = new Map<string, ManifestV5>();
  for (const build of plan.builds) manifests.set(build.captureId, manifestV5Schema.parse(json(await readCapture(archive, build.captureId))));
  const pipelines = await pipelineSelection(plan, manifests, archive);
  const left: ComparisonSample[] = [], nativeProfiles: ComparisonSample[] = [], rightIndex = new Map<string, ComparisonSample>();
  const inventory = new Map<string, { rawFields: string[]; unmappedFields: string[] }>();
  const failures: { id: string; error: string }[] = [];
  let capturedBytes = 0, profileCount = 0;
  for (const request of plan.requests) {
    try {
      const capture = await readCapture(archive, request.id, { url: request.url }); capturedBytes += capture.bytes;
      if (capture.status !== 200) throw new Error(`HTTP ${capture.status}`);
      if (request.kind === 'av-samples') left.push(...normalizeAvSamples(manifests.get(request.buildCapture!)!, request.av!, json(capture), request.id));
      else if (request.kind === 'av-profile') {
        const site = plan.sites.find(site => site.id === request.siteId)!;
        const result = normalizeAvProfile(manifests.get(request.buildCapture!)!, site, json(capture), request.id);
        const frames = new URL(request.url).searchParams.get('frame')?.split(',');
        if (!frames || frames.length !== result.profiles.length || new Set(frames).size !== frames.length
          || result.profiles.some(frame => !frames.includes(frame.id))) throw new Error('AV profile response frame selection differs from request');
        nativeProfiles.push(...result.samples); profileCount++;
      }
      else {
        const capturedAt = Date.parse(capture.capturedAt);
        if (capturedAt < beforeTime || capturedAt > afterTime) throw new Error('XC response falls outside runtime snapshot capture times');
        const site = plan.sites.find(site => site.id === request.siteId)!;
        const result = normalizeXcProfile(parseXcPayload(capture.body), { siteId: site.id, lat: site.lat, lon: site.lon, model: request.model,
          sourceRef: request.id, runtimesBefore: before, runtimesAfter: after });
        const staged: { key: string; row: ComparisonSample }[] = [];
        for (const row of result.samples) {
          const key = JSON.stringify([row.siteId, row.model, row.cycle, row.validTime]);
          const existing = rightIndex.get(key);
          if (existing && (existing.groundM !== row.groundM || JSON.stringify(existing.values) !== JSON.stringify(row.values))) {
            throw new Error('Overlapping XC captures disagree');
          }
          staged.push({ key, row });
        }
        for (const { key, row } of staged) if (!rightIndex.has(key)) rightIndex.set(key, row);
        const previous = inventory.get(request.model);
        inventory.set(request.model, {
          rawFields: [...new Set([...(previous?.rawFields ?? []), ...result.rawFields])].sort(),
          unmappedFields: [...new Set([...(previous?.unmappedFields ?? []), ...result.unmappedFields])].sort()
        });
      }
    } catch (error) { failures.push({ id: request.id, error: error instanceof Error ? error.message : String(error) }); }
  }
  const right = [...rightIndex.values()];
  const currentBuilds = new Set(pipelines.buildMetadata.filter(build => build.isCurrentPipeline).map(build => `${build.model}/${build.buildId}`));
  const currentReport = buildReport(left.filter(row => currentBuilds.has(`${row.model}/${row.buildId}`)), right, COMPARISON_MAPPINGS, plan.sites);
  const groups = new Map<string, typeof pipelines.buildMetadata>();
  for (const build of pipelines.buildMetadata) {
    const key = `${build.model}/${build.pipelineSignature}`, group = groups.get(key) ?? [];
    group.push(build); groups.set(key, group);
  }
  const byPipeline = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, builds]) => {
    const first = builds[0], ids = new Set(builds.map(build => build.buildId));
    const result = buildReport(left.filter(row => row.model === first.model && ids.has(row.buildId!)),
      right.filter(row => row.model === first.model), COMPARISON_MAPPINGS, plan.sites);
    return { model: first.model, signature: first.pipelineSignature, isCurrentPipeline: first.isCurrentPipeline,
      buildIds: [...ids].sort(), cycles: [...new Set(builds.map(build => build.cycle))].sort(),
      counts: result.counts, daylight: result.daylight, headline: result.headline };
  });
  const pooled = buildReport(left, right, COMPARISON_MAPPINGS, plan.sites);
  const report = { ...pooled, basis: { ...pooled.basis, pipelineSelection: 'all captured builds, including historical pipeline versions' },
    currentPipeline: { ...currentReport, basis: { ...currentReport.basis, pipelineSelection: 'matches each model current pipeline signature' } },
    byPipeline, referenceTime: plan.referenceTime, analysis,
    collection: { plannedRequests: plan.requests.length, failures, capturedBytes, nativeProfileResponses: profileCount, builds: plan.builds,
      ...pipelines,
      xcFields: Object.fromEntries(inventory), nativeDiagnosticFields: [...new Set(nativeProfiles.flatMap(row => Object.keys(row.values)))].sort(),
      nativeDiagnosticSamples: nativeProfiles.length }, sites: plan.sites };
  if ((await readComparisonAnalysis()).hash !== analysis.hash) throw new Error('Comparison sources changed during replay');
  await writeFile(join(out, 'normalized.json'), JSON.stringify({ left, right, nativeProfiles, analysis }) + '\n');
  await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  return report;
}
