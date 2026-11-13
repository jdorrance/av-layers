import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gridToGeographic } from '@av/contracts';
import { fixturePointBuild, fixturePointSample, fixtureProfileBuild, fixtureProfileResponse } from '../../../../tests/client-point-fixture.js';
import { fixtureManifestV5 } from '../../../../tests/forecast-fixture.js';
import { writeCapture } from './archive.js';
import { planComparison, readComparisonAnalysis, replayComparison, type ComparisonPlan } from './session.js';
import { planAvSampleRequests } from './av-layers.js';

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'av-comparison-session-')); directories.push(path); return path;
}
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const site = { id: 'valley', name: 'Test valley', lat: 40.2, lon: 44.3, region: 'europe-caucasus' as const,
  terrain: 'valley' as const, timezone: 'Asia/Yerevan', source: 'test fixture' };
const firstEpoch = Date.parse('2026-10-30T12:00:00Z') / 1000;

describe('comparison session', () => {
  it('fingerprints uncommitted analysis sources, dependencies and runtime separately from documentation and tests', async () => {
    const root = await directory(), actual = await readComparisonAnalysis();
    const sources = ['apps/batch/src/comparison', 'packages/contracts/src', 'packages/solar/src',
      'packages/soaring/src', 'packages/thermodynamics/src'].map(path => `${path}/fixture.ts`);
    sources.push('apps/batch/src/local-file.ts', 'packages/forecast/src/sampler.ts');
    for (const path of [...sources, ...Object.keys(actual.dependencyFiles)]) {
      await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), path);
    }
    const original = await readComparisonAnalysis(root);
    expect(original.runtime.node).toBe(process.version);
    expect(original.runtime.versions.icu).toBe(process.versions.icu);
    expect(await readComparisonAnalysis(root)).toEqual(original);
    await writeFile(join(root, 'apps/batch/src/comparison/fixture.test.ts'), 'ignored test');
    await writeFile(join(root, 'apps/batch/src/comparison/README.md'), 'ignored prose');
    expect(await readComparisonAnalysis(root)).toEqual(original);
    await writeFile(join(root, sources[0]), 'changed local decoder');
    const edited = await readComparisonAnalysis(root);
    expect(edited.sourceHash).not.toBe(original.sourceHash);
    expect(edited.hash).not.toBe(original.hash);
    expect(edited.dependencyHash).toBe(original.dependencyHash);
    await writeFile(join(root, 'pnpm-lock.yaml'), 'changed dependency resolution');
    const locked = await readComparisonAnalysis(root);
    expect(locked.sourceHash).toBe(edited.sourceHash);
    expect(locked.dependencyHash).not.toBe(edited.dependencyHash);
    expect(locked.hash).not.toBe(edited.hash);
  });

  it('keeps latest rebuild first and matches retained cycles/times by instant', async () => {
    const out = await directory(), sitesPath = join(out, 'sites.json');
    await writeFile(sitesPath, JSON.stringify([site]));
    const latest = fixtureProfileBuild({ frameHours: [12, 13] }).manifest;
    const olderBuild = fixtureManifestV5({ ...latest, buildId: '20261030T000000Z-00000000-0000-4000-8000-000000000001',
      surfaces: undefined, artifacts: undefined });
    const retained = fixtureManifestV5({ ...latest, buildId: '20261029T000000Z-00000000-0000-4000-8000-000000000002',
      cycle: '2026-10-29T00:00:00Z', surfaces: undefined, artifacts: undefined,
      frames: latest.frames.map(frame => ({ ...frame, validTime: frame.validTime.replace('.000Z', 'Z') })) });
    const manifests = [latest, olderBuild, retained];
    const runtime = { runtimes: { gfs: [
      { zday: 20261029, zrun: 0, fhour: 36, epoch: firstEpoch, state: 'valid' },
      { zday: 20261030, zrun: 0, fhour: 13, epoch: firstEpoch + 3600, state: 'valid' }
    ] } };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async input => {
      const url = new URL(String(input));
      let body: unknown;
      if (url.hostname.endsWith('.xcskies.com')) body = runtime;
      else if (url.pathname === '/v1/catalog') body = { models: [{ model: 'gfs', available: true, bounds: [-180, -90, 180, 90] }] };
      else if (url.pathname.endsWith('/latest')) body = { manifest: latest };
      else if (url.pathname.endsWith('/runs')) body = { retained: [olderBuild, retained, latest].map(({ buildId, cycle }) => ({ buildId, cycle })) };
      else body = manifests.find(manifest => url.pathname.endsWith(`/${manifest.buildId}`));
      if (!body) throw new Error(`Unexpected request ${url.href}`);
      return new Response(JSON.stringify(body));
    });
    vi.stubGlobal('fetch', fetcher);
    const plan = await planComparison(out, { sites: sitesPath, referenceTime: '2026-10-30T12:00:00Z', apiBase: 'https://api.test' });
    expect(plan.builds.map(build => build.buildId)).toEqual([latest.buildId, retained.buildId]);
    expect(plan.builds[0]?.frames).toEqual(['f012', 'f013']);
    expect(plan.builds[1]?.frames).toEqual(['f012']);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(`/${olderBuild.buildId}`))).toBe(false);
  });

  it('rejects a conflicting XC response atomically and unions fields across successful captures on offline replay', async () => {
    const out = await directory(), archive = join(out, 'captures'), runtimeUrl = 'https://n1.xcskies.com/runtimes/all/test';
    const requests: ComparisonPlan['requests'] = ['first', 'second', 'conflict'].map(id => ({ id,
      url: `https://n1.xcskies.com/profile/gfs/test?request=${id}`, kind: 'xc-profile', model: 'gfs', siteId: site.id }));
    const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T12:00:00.000Z', apiBase: 'https://api.test',
      sites: [site], runtimeUrl, builds: [], requests };
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
    const runtime = { runtimes: { gfs: [11, 12, 13].map(fhour => ({ zday: 20261030, zrun: 0, fhour,
      epoch: firstEpoch + (fhour - 12) * 3600, state: 'valid' })) } };
    const save = (id: string, url: string, body: unknown, capturedAt = '2026-10-30T12:01:00.000Z') => writeCapture(archive, id, {
      url, status: 200, capturedAt, body: JSON.stringify(body) });
    await save('xc-runtimes-before', runtimeUrl, runtime, '2026-10-30T12:00:00.000Z');
    await save('xc-runtimes-after', runtimeUrl, runtime, '2026-10-30T12:02:00.000Z');
    await save('first', requests[0]!.url, { status: 1, epochs: [firstEpoch], elevs: [100], vtops: [150], firstOnly: [1] });
    await save('second', requests[1]!.url, { status: 1, epochs: [firstEpoch + 3600], elevs: [100], vtops: [160], secondOnly: [1] });
    await save('conflict', requests[2]!.url, { status: 1, epochs: [firstEpoch - 3600, firstEpoch], elevs: [100, 100], vtops: [140, 200], rejectedOnly: [1, 1] });
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('Replay must remain offline')); vi.stubGlobal('fetch', network);
    const report = await replayComparison(out);
    expect(report.collection.failures).toEqual([{ id: 'conflict', error: 'Overlapping XC captures disagree' }]);
    expect(report.counts.rightSamples).toBe(2);
    expect(report.collection.xcFields.gfs?.unmappedFields).toEqual(['firstOnly', 'secondOnly']);
    const normalized = JSON.parse(await readFile(join(out, 'normalized.json'), 'utf8')) as {
      right: { validTime: string; sourceRef: string }[]; analysis: typeof report.analysis };
    expect(normalized.right.map(row => row.sourceRef)).toEqual(['first', 'second']);
    expect(normalized.analysis).toEqual(report.analysis);
    expect(report.analysis.sourceFiles['apps/batch/src/comparison/core.ts']).toMatch(/^[a-f0-9]{64}$/);
    expect(report.analysis.dependencyFiles['pnpm-lock.yaml']).toMatch(/^[a-f0-9]{64}$/);
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['2026-10-30T11:59:00.000Z', '2026-10-30T12:03:00.000Z'])(
    'records an XC response captured at %s outside its runtime snapshots as a failure', async capturedAt => {
      const out = await directory(), archive = join(out, 'captures'), runtimeUrl = 'https://n1.xcskies.com/runtimes/all/test';
      const request: ComparisonPlan['requests'][number] = { id: 'outside-window', kind: 'xc-profile', model: 'gfs', siteId: site.id,
        url: 'https://n1.xcskies.com/profile/gfs/test' };
      const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T12:00:00.000Z', apiBase: 'https://api.test',
        sites: [site], runtimeUrl, builds: [], requests: [request] };
      await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
      const runtime = { runtimes: { gfs: [{ zday: 20261030, zrun: 0, fhour: 12, epoch: firstEpoch, state: 'valid' }] } };
      for (const [id, time] of [['xc-runtimes-before', '2026-10-30T12:00:00.000Z'], ['xc-runtimes-after', '2026-10-30T12:02:00.000Z']]) {
        await writeCapture(archive, id, { url: runtimeUrl, status: 200, capturedAt: time, body: JSON.stringify(runtime) });
      }
      await writeCapture(archive, request.id, { url: request.url, status: 200, capturedAt,
        body: JSON.stringify({ status: 1, epochs: [firstEpoch], elevs: [100], vtops: [150] }) });
      const report = await replayComparison(out);
      expect(report.collection.failures).toEqual([{ id: request.id, error: 'XC response falls outside runtime snapshot capture times' }]);
      expect(report.counts.rightSamples).toBe(0);
    }
  );

  it('rejects reversed runtime snapshots before reporting', async () => {
    const out = await directory(), archive = join(out, 'captures'), runtimeUrl = 'https://n1.xcskies.com/runtimes/all/test';
    const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T12:00:00.000Z', apiBase: 'https://api.test',
      sites: [site], runtimeUrl, builds: [], requests: [] };
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
    for (const [id, capturedAt] of [['xc-runtimes-before', '2026-10-30T12:02:00.000Z'], ['xc-runtimes-after', '2026-10-30T12:00:00.000Z']]) {
      await writeCapture(archive, id, { url: runtimeUrl, status: 200, capturedAt, body: JSON.stringify({ runtimes: {} }) });
    }
    await expect(replayComparison(out)).rejects.toThrow('runtime snapshot capture times are reversed');
  });

  it('records a truncated AV native profile as a collection failure', async () => {
    const out = await directory(), archive = join(out, 'captures'), runtimeUrl = 'https://n1.xcskies.com/runtimes/all/test';
    const build = fixtureProfileBuild({ frameHours: [12, 13] }), manifest = build.manifest;
    const native = manifest.surfaces.find(surface => surface.kind === 'native')!;
    const point = gridToGeographic(native.grid, 0, 0)!, nativeSite = { ...site, lat: point.lat, lon: point.lon };
    const url = new URL(`https://api.test/v1/models/gfs/runs/${manifest.buildId}/profile`);
    url.search = new URLSearchParams({ lat: String(point.lat), lon: String(point.lon), frame: 'f012,f013', layers: 'thermal-top-msl' }).toString();
    const request: ComparisonPlan['requests'][number] = { id: 'truncated', kind: 'av-profile', model: 'gfs', siteId: nativeSite.id,
      url: url.href, buildCapture: 'manifest' };
    const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T12:00:00.000Z', apiBase: 'https://api.test',
      sites: [nativeSite], runtimeUrl, builds: [{ captureId: 'manifest', model: 'gfs', buildId: manifest.buildId, cycle: manifest.cycle,
        frames: ['f012', 'f013'] }], requests: [request] };
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
    const capturedAt = '2026-10-30T12:00:00.000Z';
    for (const id of ['xc-runtimes-before', 'xc-runtimes-after']) {
      await writeCapture(archive, id, { url: runtimeUrl, status: 200, capturedAt, body: JSON.stringify({ runtimes: {} }) });
    }
    await writeCapture(archive, 'manifest', { url: `https://api.test/v1/models/gfs/runs/${manifest.buildId}`,
      status: 200, capturedAt, body: JSON.stringify(manifest) });
    const response = fixtureProfileResponse(build, url.href);
    response.frames.pop();
    await writeCapture(archive, request.id, { url: request.url, status: 200, capturedAt, body: JSON.stringify(response) });
    const report = await replayComparison(out);
    expect(report.collection.failures).toEqual([{ id: request.id, error: 'AV profile response frame selection differs from request' }]);
    expect(report.collection.nativeProfileResponses).toBe(0);
    expect(report.collection.nativeDiagnosticSamples).toBe(0);
    expect(report.collection.currentPipelines[0]?.source).toBe('newest-retained-cycle');
  });

  it.each(['science', 'dependencies'])('separates historical %s from the archived current pipeline', async changed => {
    const out = await directory(), archive = join(out, 'captures'), runtimeUrl = 'https://n1.xcskies.com/runtimes/all/test';
    const base = fixturePointBuild({ frameHours: [12] });
    const components = { adapter: 'a'.repeat(64), science: 'b'.repeat(64), contracts: 'c'.repeat(64), configuration: 'd'.repeat(64) };
    const current = fixtureManifestV5({ ...base.manifest, tool: { ...base.manifest.tool, components, useStoredMslNoLift: true } });
    const historical = fixtureManifestV5({ ...current, buildId: '20261029T000000Z-00000000-0000-4000-8000-000000000001',
      cycle: '2026-10-29T00:00:00.000Z', surfaces: undefined, artifacts: undefined,
      frames: current.frames.map(frame => ({ ...frame, validTime: frame.validTime.replace('2026-10-30', '2026-10-29'),
        intervalStart: frame.intervalStart.replace('2026-10-30', '2026-10-29'), intervalEnd: frame.intervalEnd.replace('2026-10-30', '2026-10-29') })),
      tool: { ...current.tool, components: { ...components, science: changed === 'science' ? 'e'.repeat(64) : components.science } },
      recipe: { ...current.recipe, lockHash: changed === 'dependencies' ? 'e'.repeat(64) : current.recipe.lockHash } });
    expect(historical.method).toEqual(current.method);
    const plan: ComparisonPlan = { version: 1, referenceTime: '2026-10-30T12:00:00.000Z', apiBase: 'https://api.test',
      sites: [site], runtimeUrl, builds: [], requests: [] };
    const save = (id: string, url: string, body: unknown, capturedAt = '2026-10-30T12:01:00.000Z') => writeCapture(archive, id, {
      url, status: 200, capturedAt, body: JSON.stringify(body) });
    for (const [index, manifest] of [historical, current].entries()) {
      const captureId = `manifest-${index}`, [request] = planAvSampleRequests(manifest, [site], { baseUrl: plan.apiBase });
      plan.builds.push({ captureId, model: 'gfs', buildId: manifest.buildId, cycle: manifest.cycle, frames: ['f012'] });
      plan.requests.push({ id: `samples-${index}`, url: request.url, kind: 'av-samples', model: 'gfs', buildCapture: captureId, av: request });
      const url = new URL(request.url);
      url.searchParams.set('lat', String(site.lat)); url.searchParams.set('lon', String(site.lon));
      const sample = fixturePointSample({ ...base, manifest }, url.href);
      sample.frames[0].layers['usable-lift-msl'].value = index === 0 ? 3500 : 2500;
      await save(captureId, `https://api.test/v1/models/gfs/runs/${manifest.buildId}`, manifest);
      await save(`samples-${index}`, request.url, { version: 1, model: 'gfs', buildId: manifest.buildId, expiresAt: manifest.expiresAt,
        points: [{ index: 0, sample }] });
    }
    await save('av-latest-gfs', 'https://api.test/v1/models/gfs/latest?expand=manifest', { manifest: current });
    const runtime = { runtimes: { gfs: [29, 30].map(day => ({ zday: Number(`202610${day}`), zrun: 0, fhour: 12,
      epoch: firstEpoch - (30 - day) * 86400, state: 'valid' })) } };
    await save('xc-runtimes-before', runtimeUrl, runtime, '2026-10-30T12:00:00.000Z');
    await save('xc-runtimes-after', runtimeUrl, runtime, '2026-10-30T12:02:00.000Z');
    const xc = { id: 'xc', url: 'https://n1.xcskies.com/profile/gfs/test', kind: 'xc-profile' as const, model: 'gfs' as const, siteId: site.id };
    plan.requests.push(xc);
    await save(xc.id, xc.url, { status: 1, epochs: [firstEpoch - 86400, firstEpoch], elevs: [150, 150], vtops: [200, 200] });
    await writeFile(join(out, 'plan.json'), JSON.stringify(plan));
    const report = await replayComparison(out);
    expect(report.collection.failures).toEqual([]);
    expect(report.headline.find(row => row.parameter === 'usable-lift-msl')?.meanDifference).toBe(1000);
    expect(report.currentPipeline.headline.find(row => row.parameter === 'usable-lift-msl')?.meanDifference).toBe(500);
    expect(report.currentPipeline.counts.leftSamples).toBe(1);
    expect(report.collection.currentPipelines[0]).toMatchObject({ buildId: current.buildId, source: 'archived-latest' });
    expect(report.collection.buildMetadata.map(build => build.isCurrentPipeline)).toEqual([false, true]);
    expect(new Set(report.collection.buildMetadata.map(build => build.pipelineSignature)).size).toBe(2);
    expect(report.byPipeline).toHaveLength(2);
    expect(report.byPipeline.map(group => group.counts.leftSamples)).toEqual([1, 1]);
    expect(report.collection.buildMetadata[0].components.science).toBe(changed === 'science' ? 'e'.repeat(64) : components.science);
    expect(report.collection.buildMetadata[0].lockHash).toBe(historical.recipe.lockHash);
    const captured = JSON.parse((await readFile(join(archive, 'manifest-0.json'), 'utf8'))) as { body: string };
    expect(JSON.parse(captured.body).tool.components.science).toBe(changed === 'science' ? 'e'.repeat(64) : components.science);
  });
});
