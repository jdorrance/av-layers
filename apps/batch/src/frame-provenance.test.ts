import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { encodeBoundedJson, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS, parseProvenance, type Manifest, type ProvenanceFrameReference } from '@av/contracts';
import { readFrameProvenance, writeFrameProvenance } from './frame-provenance.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const identity = { model: 'gfs', buildId: 'provenance-test', cycle: '2026-11-05T00:00:00.000Z' };
function frame(hour: number): Manifest['frames'][number] {
  const time = Date.parse(identity.cycle) + hour * 3_600_000;
  return { id: `f${String(hour).padStart(3, '0')}`, validTime: new Date(time).toISOString(), intervalStart: new Date(time - 3_600_000).toISOString(), intervalEnd: new Date(time).toISOString() };
}
const intervals = (value: ReturnType<typeof frame>) => ({ profileTime: value.validTime, fluxWindow: { start: value.intervalStart, end: value.intervalEnd } });
async function root() { const value = await mkdtemp(join(tmpdir(), 'av-provenance-')); roots.push(value); return value; }

it('keeps a full run larger than the provenance budget in bounded verified frame files', async () => {
  const directory = await root(), frames = Array.from({ length: 24 }, (_, index) => frame(index + 1));
  const refs: ProvenanceFrameReference[] = [];
  for (const [index, value] of frames.entries()) refs.push(await writeFrameProvenance(directory, identity, value,
    { hour: index + 1, intervals: intervals(value), receipt: { inventory: 'x'.repeat(200_000) } }));
  expect(refs.reduce((total, ref) => total + ref.bytes, 0)).toBeGreaterThan(MAX_PROVENANCE_BYTES);
  const index = { version: 2, ...identity, frames: refs };
  expect(encodeBoundedJson(index, MAX_PROVENANCE_BYTES, MAX_PROVENANCE_JSON_TOKENS).length).toBeLessThan(10_000);
  expect(parseProvenance(index, { ...identity, frames }).frames).toHaveLength(24);
  expect((await readFrameProvenance(directory, identity, frames[23]!, refs[23]!)).hour).toBe(24);
  expect(() => parseProvenance({ ...index, frames: refs.slice(1) }, { ...identity, frames })).toThrow('Incomplete');
  expect(() => parseProvenance({ ...index, frames: [...refs].reverse() }, identity)).toThrow('reference');
});

it('rejects mismatched windows, references and changed chunk bytes', async () => {
  const directory = await root(), value = frame(1), receipt = { hour: 1, intervals: intervals(value), receipt: {} };
  await expect(writeFrameProvenance(directory, identity, value, { ...receipt, intervals: intervals(frame(2)) })).rejects.toThrow('match');
  const ref = await writeFrameProvenance(directory, identity, value, receipt);
  await expect(readFrameProvenance(directory, identity, value, { ...ref, key: '../outside.json' })).rejects.toThrow('reference');
  await writeFile(join(directory, ref.key), ' '.repeat(ref.bytes));
  await expect(readFrameProvenance(directory, identity, value, ref)).rejects.toThrow('hash');
});
