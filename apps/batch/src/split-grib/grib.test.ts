import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { SPLIT_PRODUCT } from '../../../../tests/model-fixtures.js';
import { createSplitGribDecoder, splitGribWorkspaceBytes } from './grib.js';
import { MAX_SPLIT_OBJECT_BYTES, splitSource } from './source.js';

const source = splitSource(SPLIT_PRODUCT), directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function childProgram(body: string) {
  const directory = await mkdtemp(join(tmpdir(), 'av-decoder-')); directories.push(directory);
  const executable = join(directory, 'python'), ready = join(directory, 'ready');
  await writeFile(executable, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(ready)}, String(process.pid));\n${body}\n`, { mode: 0o700 });
  vi.stubEnv('AV_ECCODES_PYTHON', executable);
  return async () => {
    let pid = 0;
    await vi.waitFor(async () => { pid = Number(await readFile(ready, 'utf8')); }, { timeout: 5000, interval: 10 });
    return pid;
  };
}

it.each([
  ['oversized metadata', "const h=Buffer.alloc(8);h.writeUInt32LE(32769);process.stdout.write(h);setInterval(()=>{},1000)", /response exceeds/],
  ['malformed JSON', "const h=Buffer.alloc(8);h.writeUInt32LE(1);process.stdout.write(Buffer.concat([h,Buffer.from('{')]));setInterval(()=>{},1000)", /response metadata/],
  ['truncated payload', "const m=Buffer.from(JSON.stringify({precision:4,peakNativeRssBytes:1})),h=Buffer.alloc(8);h.writeUInt32LE(m.length);h.writeUInt32LE(5,4);process.stdout.write(Buffer.concat([h,m,Buffer.of(0)]));", /decoder exited/],
  ['excess native memory', "const m=Buffer.from(JSON.stringify({precision:4,peakNativeRssBytes:2**40})),h=Buffer.alloc(8);h.writeUInt32LE(m.length);process.stdout.write(Buffer.concat([h,m]));setInterval(()=>{},1000)", /memory exceeds/]
] as const)('closes the native process and rejects queued fields after %s', async (_name, program, error) => {
  const pid = await childProgram(program), decoder = createSplitGribDecoder(source, Uint32Array.of(0));
  const results = Promise.allSettled([decoder.decode(Buffer.of(0)), decoder.decode(Buffer.of(0))]);
  const processId = await pid();
  try {
    for (const result of await results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(result.reason.message).toMatch(error); }
  } finally { await decoder.close(); }
  expect(() => process.kill(processId, 0)).toThrow();
});

it('aborts an in-flight decoder and settles every queued field before close returns', async () => {
  const pid = await childProgram('process.stdout.write(Buffer.of(1));setInterval(()=>{},1000)');
  const controller = new AbortController(), decoder = createSplitGribDecoder(source, Uint32Array.of(0), controller.signal);
  const results = Promise.allSettled(Array.from({ length: 8 }, () => decoder.decode(Buffer.of(0))));
  const processId = await pid();
  await expect(decoder.decode(Buffer.of(0))).rejects.toThrow(/queue exceeds/);
  controller.abort(new Error('test cancellation'));
  await decoder.close();
  expect((await results).every(result => result.status === 'rejected' && result.reason.message === 'test cancellation')).toBe(true);
  expect(() => process.kill(processId, 0)).toThrow();
  await expect(decoder.decode(Buffer.of(0))).rejects.toThrow('test cancellation');
});

it('rejects oversized input before starting native work and admits its complete workspace', async () => {
  const decoder = createSplitGribDecoder(source, Uint32Array.of(0));
  try {
    await expect(decoder.decode(new Uint8Array(MAX_SPLIT_OBJECT_BYTES + 1))).rejects.toThrow(/byte length/);
    expect(decoder.stats.peakNativeRssBytes).toBe(0);
    expect(splitGribWorkspaceBytes(source.grid.width * source.grid.height, 1)).toBeGreaterThan(320 * 1024 ** 2);
    expect(() => splitGribWorkspaceBytes(4, 5)).toThrow();
  } finally { await decoder.close(); }
});
