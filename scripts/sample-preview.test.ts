import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { forecastObjects, manifestSchema } from '@av/contracts';

const commands = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('node:child_process', () => commands);

const temporary: string[] = [];
const originalArgv = process.argv;
const originalExitCode = process.exitCode;
afterEach(async () => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.resetAllMocks();
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function preview(options: { receipt?: 'valid' | 'missing' | 'corrupt' | 'wrong cycle' | 'wrong schema'; seeded?: boolean }) {
  const root = await mkdtemp(join(tmpdir(), 'av-preview-provenance-')); temporary.push(root);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL('./fixtures/manifest.contract.json', import.meta.url), 'utf8')));
  manifest.expiresAt = new Date(Date.now() + 86400000).toISOString();
  const prefix = `builds/${manifest.model}/${manifest.buildId}`;
  const provenanceKey = `${prefix}/provenance.json`;
  const receipt = Buffer.from(JSON.stringify({ version: options.receipt === 'wrong schema' ? 2 : 1, model: manifest.model, buildId: manifest.buildId, cycle: options.receipt === 'wrong cycle' ? '2026-10-29T00:00:00.000Z' : manifest.cycle, frames: [] }));
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  if (options.receipt) manifest.source = { provenanceKey, provenanceSha256: hash(receipt) };
  for (const { key } of forecastObjects(manifest)) {
    await mkdir(dirname(join(root, key)), { recursive: true });
    await writeFile(join(root, key), 'fixture artifact');
  }
  if (options.receipt && options.receipt !== 'missing') await writeFile(join(root, provenanceKey), options.receipt === 'corrupt' ? 'corrupt receipt' : receipt);
  const manifestPath = join(root, prefix, 'manifest.json'), manifestBytes = Buffer.from(JSON.stringify(manifest));
  await writeFile(manifestPath, manifestBytes);
  const persist = join(root, 'state');
  if (options.seeded) {
    await mkdir(join(persist, '.sample-preview'), { recursive: true });
    await writeFile(join(persist, '.sample-preview', `${manifest.buildId}-${hash(manifestBytes).slice(0, 16)}.json`), '{}');
  }
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  commands.spawnSync.mockReturnValue({ status: 0 });
  commands.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() });
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  });
  process.argv = ['node', fileURLToPath(new URL('./sample-preview.ts', import.meta.url)), '--manifest', manifestPath, '--persist-to', persist];
  vi.resetModules();
  await import('./sample-preview.ts');
  await vi.waitFor(() => expect(commands.spawn.mock.calls.length + errors.mock.calls.length).toBeGreaterThan(0));
  return { manifest, provenanceKey, errors, objectKeys: commands.spawnSync.mock.calls.map(call => (call[1] as string[])[4]) };
}

describe('local preview provenance', () => {
  it('seeds verified provenance before exposing the manifest and latest pointer', async () => {
    const { manifest, provenanceKey, objectKeys } = await preview({ receipt: 'valid' });
    expect(objectKeys[0]).toMatch(new RegExp(`${provenanceKey}$`));
    expect(objectKeys.at(-2)).toMatch(new RegExp(`builds/gfs/${manifest.buildId}/manifest.json$`));
    expect(objectKeys.at(-1)).toMatch(/catalog\/gfs\/latest\.json$/);
    expect(commands.spawn).toHaveBeenCalledOnce();
  });
  it('repairs receipt seeding for a build already marked as seeded', async () => {
    const { provenanceKey, objectKeys } = await preview({ receipt: 'valid', seeded: true });
    expect(objectKeys).toHaveLength(2);
    expect(objectKeys[0]).toMatch(new RegExp(`${provenanceKey}$`));
    expect(objectKeys[1]).toMatch(/catalog\/gfs\/latest\.json$/);
  });
  it.each(['missing', 'corrupt', 'wrong cycle', 'wrong schema'] as const)('rejects %s provenance before seeding any objects or starting Wrangler', async receipt => {
    const { errors } = await preview({ receipt });
    expect(errors).toHaveBeenCalledWith(expect.stringMatching(/provenance|version/i));
    expect(commands.spawnSync).not.toHaveBeenCalled();
    expect(commands.spawn).not.toHaveBeenCalled();
  });
  it('seeds numeric v2 builds with inline provenance', async () => {
    const { objectKeys } = await preview({});
    expect(objectKeys).toHaveLength(27);
    expect(objectKeys.some(key => key.endsWith('/provenance.json'))).toBe(false);
    expect(commands.spawn).toHaveBeenCalledOnce();
  });
});
