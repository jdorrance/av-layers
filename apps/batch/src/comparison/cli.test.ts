import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from './cli.js';
import type { ComparisonSample, ParameterMapping } from './core.js';

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'av-comparison-cli-')); directories.push(dir);
  const left: ComparisonSample[] = [{ provider: 'first', siteId: 'valley', model: 'gfs', product: 'noaa-gfs-0p25',
    cycle: '2026-11-13T00:00:00Z', validTime: '2026-11-13T12:00:00Z', lat: 40.2, lon: 44.3, sourceRef: 'left-capture',
    values: { top: { value: 1500, status: 'valid', unit: 'm', verticalReference: 'MSL', definition: 'usable-lift-top', timeSupport: 'valid-time' } } }];
  const right = structuredClone(left); right[0]!.provider = 'second'; right[0]!.sourceRef = 'right-capture'; right[0]!.values.top!.value = 1800;
  const mappings: ParameterMapping[] = [{ id: 'lift', leftParameter: 'top', rightParameter: 'top', comparability: 'related', note: 'Different parcel methods.' }];
  const sites = [{ id: 'valley', name: 'Valley', lat: 40.2, lon: 44.3, region: 'europe-caucasus', terrain: 'valley', timezone: 'Asia/Yerevan', source: 'fixture' }];
  for (const [name, value] of Object.entries({ left, right, mappings, sites })) await writeFile(join(dir, `${name}.json`), JSON.stringify(value));
  const out = join(dir, 'result'), args = ['compare', '--left', join(dir, 'left.json'), '--right', join(dir, 'right.json'),
    '--sites', join(dir, 'sites.json'), '--mappings', join(dir, 'mappings.json'), '--out', out];
  return { dir, out, args };
}

describe('offline comparison command', () => {
  it('compares supplied normalized snapshots without network or archive discovery', async () => {
    const { out, args } = await fixture();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('Offline command attempted network'));
    vi.stubGlobal('fetch', fetcher); const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await main(args);
    const report = JSON.parse(await readFile(join(out, 'report.json'), 'utf8'));
    expect(report.counts).toMatchObject({ leftSamples: 1, rightSamples: 1, numericPairs: 1, matchedSites: 1 });
    expect(report.overall[0]).toMatchObject({ parameter: 'lift', meanDifference: -300, comparability: 'related' });
    expect(report.analysis.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.topDiscrepancies[0].pairs[0]).toMatchObject({ leftSourceRef: 'left-capture', rightSourceRef: 'right-capture' });
    expect(fetcher).not.toHaveBeenCalled(); expect(log).toHaveBeenCalledTimes(1);
  });

  it('requires each explicit input and rejects invalid containers before writing a report', async () => {
    const { dir, out, args } = await fixture();
    await expect(main(['compare', '--out', out])).rejects.toThrow('--left FILE');
    for (const invalid of [{ left: [] }, [null]]) {
      await writeFile(join(dir, 'left.json'), JSON.stringify(invalid));
      await expect(main(args)).rejects.toThrow('array of objects');
    }
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('bounds file allocation and preserves an input named report.json', async () => {
    const { dir, out, args } = await fixture();
    await truncate(join(dir, 'left.json'), 64 * 1024 ** 2 + 1);
    await expect(main(args)).rejects.toThrow('byte budget');
    await expect(stat(out)).rejects.toMatchObject({ code: 'ENOENT' });
    const collision = [...args]; collision[collision.indexOf('--left') + 1] = join(out, 'report.json');
    await expect(main(collision)).rejects.toThrow('different path');
  });
});
