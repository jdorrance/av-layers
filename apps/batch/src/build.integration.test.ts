import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { manifestV5Schema, parseProvenance } from '@av/contracts';
import { OFFLINE_PRODUCT } from '@av/contracts/fixture-product';
import { normalizedFixtureFrame } from '../../../scripts/fixtures/normalized-provider.js';
import { denseFixtureMask, syntheticWholeDomain } from '../../../scripts/fixtures/whole-domain.js';
import { buildForecast } from './build.js';
import { BUILD_BUDGETS } from './capacity.js';
import type { ForecastProvider } from './provider.js';
import { assertValidatedBuild, finalizeValidatedMetrics, type ValidatedBuild } from './validate.js';

const cycle = '2026-10-30T00:00:00.000Z';
const product = { ...OFFLINE_PRODUCT, maxNativeZoom: 0, mapEndHour: 1, execution: { ...OFFLINE_PRODUCT.execution, workers: 0 } };
const mask = denseFixtureMask(product, product.grid);
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const out = await mkdtemp(join(tmpdir(), 'av-serial-v5-'));
  roots.push(out);
  const wholeDomain = await syntheticWholeDomain(out, product);
  const close = vi.fn(async () => {});
  const frame = (hour: number, active: Uint32Array) => normalizedFixtureFrame(product.grid, active, cycle, hour, product.intervalHours);
  const acquire = vi.fn(async (hour: number, active: Uint32Array) => frame(hour, active));
  const open = vi.fn<ForecastProvider['open']>(async ({ activeIndices }) => ({
    cycle, acquire: hour => acquire(hour, activeIndices), close, stats: { fixture: true }
  }));
  const provider: ForecastProvider = { id: 'synthetic', provider: 'Synthetic build test', maxLevels: 3, open };
  return { out, open, acquire, close, frame, options: { out, product, mask, provider, wholeDomain, deriveOptions: { daylightOnly: false } } };
}

it('writes an admitted v5 build with a map prefix, native tail and indexed source receipts', async () => {
  const { options, out, open, close } = await fixture();
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  let seal: ValidatedBuild | undefined;
  const cacheDir = join(out, 'cache'), requestedCycle = cycle.replace('.000Z', 'Z');
  const path = await buildForecast({ ...options, cycle: requestedCycle, cacheDir, onValidated: async result => { seal = result; } });
  const manifest = manifestV5Schema.parse(JSON.parse(await readFile(path, 'utf8')));

  expect(timeout).toHaveBeenCalledWith(BUILD_BUDGETS.elapsedMs);
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ cacheDir, cycle: requestedCycle, signal: expect.any(AbortSignal) }));
  expect(close).toHaveBeenCalledOnce();
  expect(manifest).toMatchObject({ cycle, mapFrameCount: 1, tool: { liftRenderStyle: 'transparent-no-lift-v2' },
    source: { frameCount: 2, provider: 'Synthetic build test' } });
  expect(manifest.frames.map(frame => [frame.id, frame.intervalStart, frame.intervalEnd])).toEqual([
    ['f001', cycle, '2026-10-30T01:00:00.000Z'], ['f002', '2026-10-30T01:00:00.000Z', '2026-10-30T02:00:00.000Z']
  ]);
  expect(manifest.metrics).toHaveProperty('phasesMs');
  const provenance = parseProvenance(JSON.parse(await readFile(join(out, manifest.source.provenanceKey), 'utf8')), manifest);
  expect(provenance).toMatchObject({ version: 2, frames: [{ frame: 'f001' }, { frame: 'f002' }] });
  for (const surface of manifest.surfaces) {
    expect(surface.samples.format).toBe('cell-major-block-shards-v1');
    expect(surface.samples.channelCount).toBe(surface.layers.length * (surface.kind === 'fine' ? 1 : 2));
    for (const shard of surface.samples.shards) expect((await stat(join(out, shard.key))).size).toBe(shard.bytes);
  }
  expect(manifest.artifacts).toHaveLength(3);
  for (const artifact of manifest.artifacts) expect((await stat(join(out, artifact.tilesKey))).size).toBeGreaterThan(127);
  expect(() => assertValidatedBuild(out, manifest, seal!)).not.toThrow();
  expect(() => assertValidatedBuild(join(out, 'another'), manifest, seal!)).toThrow('changed');
  seal!.manifest.method.id = 'changed';
  expect(() => finalizeValidatedMetrics(out, seal!, {})).toThrow('changed');
});

it.each(['cycle', 'profile', 'flux', 'precipitation'] as const)('rejects a mismatched %s interval and closes the provider', async field => {
  const { options, acquire, frame, close } = await fixture();
  acquire.mockImplementation(async (hour, active) => {
    const value = frame(hour, active);
    const wrong = '2026-10-30T02:00:00.000Z';
    if (field === 'cycle') value.cycle = wrong;
    if (field === 'profile') value.intervals.profileTime = wrong;
    if (field === 'flux') value.intervals.fluxWindow.end = wrong;
    if (field === 'precipitation') value.intervals.precipitationWindow!.end = wrong;
    return value;
  });
  await expect(buildForecast(options)).rejects.toThrow('Acquisition interval mismatch f1');
  expect(close).toHaveBeenCalledOnce();
});

it.each([false, true])('includes native decoder RSS in build admission (excess=%s)', async excess => {
  const { options, open, close } = await fixture();
  const implementation = open.getMockImplementation()!;
  const nativePeakRssBytes = excess ? BUILD_BUDGETS.peakRssBytes : 128 * 1024 ** 2;
  open.mockImplementation(async input => ({ ...await implementation(input), nativePeakRssBytes }));
  const before = process.resourceUsage().maxRSS * 1024;
  const build = buildForecast(options);
  if (excess) await expect(build).rejects.toThrow('Forecast process RSS exceeds the build budget');
  else {
    const manifest = manifestV5Schema.parse(JSON.parse(await readFile(await build, 'utf8')));
    expect(manifest.metrics.peakRssBytes).toBeGreaterThanOrEqual(before + nativePeakRssBytes);
  }
  expect(close).toHaveBeenCalledOnce();
});

it('journals a failed prefetch against its own frame and phase', async () => {
  const { out, options, acquire, frame, close } = await fixture();
  acquire.mockImplementation(async (hour, active) => {
    if (hour === 2) throw Object.assign(new Error('Injected field failure'), { code: 'fixture-failure', details: { hour } });
    return frame(hour, active);
  });
  await expect(buildForecast(options)).rejects.toThrow('Injected field failure');
  const builds = join(out, 'builds', product.modelId), [buildId] = await readdir(builds);
  expect(JSON.parse(await readFile(join(builds, buildId!, 'failure.json'), 'utf8'))).toMatchObject({
    state: 'failed', phase: 'acquire', completedFrames: 0, failedFrameHour: 2, cancelled: false,
    error: { code: 'fixture-failure', message: 'Injected field failure', details: { hour: 2 } }
  });
  expect(close).toHaveBeenCalledOnce();
});
