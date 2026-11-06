import { mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createLocalFileReader, readLocalFile } from './local-file.js';

const hooks = vi.hoisted(() => ({
  beforeRead: undefined as undefined | (() => void | Promise<void>),
  afterRead: undefined as undefined | (() => void),
  closeError: undefined as Error | undefined,
  closes: 0
}));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, open: async (path: Parameters<typeof actual.open>[0], flags: string) => {
    const file = await actual.open(path, flags);
    return new Proxy(file, { get(target, property) {
      if (property === 'read') return async (...args: unknown[]) => {
        await hooks.beforeRead?.();
        const result: unknown = await Reflect.apply(target.read, target, args);
        hooks.afterRead?.();
        return result;
      };
      if (property === 'close') return async () => {
        await target.close(); hooks.closes++;
        if (hooks.closeError) throw hooks.closeError;
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
  } };
});
afterEach(() => {
  hooks.beforeRead = hooks.afterRead = hooks.closeError = undefined;
  hooks.closes = 0;
  vi.restoreAllMocks();
});

it('bounds allocation using the opened file and enforces an exact reserved length', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    await writeFile(path, Uint8Array.of(1, 2, 3));
    await expect(readLocalFile(path, 3, 3)).resolves.toEqual(Buffer.from([1, 2, 3]));
    await expect(readLocalFile(path, 2)).rejects.toThrow('byte budget');
    await truncate(path, 4);
    await expect(readLocalFile(path, 8, 3)).rejects.toThrow('changed length');
    await expect(readLocalFile(path, NaN)).rejects.toThrow('byte budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('leases one allocation through the complete async consumer and reuses it for a shorter file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), first = join(root, 'first'), second = join(root, 'second');
  try {
    await writeFile(first, Uint8Array.of(1, 2, 3)); await writeFile(second, Uint8Array.of(4));
    const allocations = vi.spyOn(Buffer, 'allocUnsafe'), read = createLocalFileReader(32);
    let entered!: () => void, release!: () => void, backing: ArrayBufferLike | undefined;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = read(first, 3, async bytes => {
      backing = bytes.buffer; entered();
      await held;
      expect([...bytes]).toEqual([1, 2, 3]);
      return 'consumed';
    });
    await started;
    expect(hooks.closes).toBe(1);
    await expect(read(second, 1, () => undefined)).rejects.toThrow('buffer is in use');
    release();
    await expect(pending).resolves.toBe('consumed');
    await read(second, 1, bytes => {
      expect(bytes.buffer).toBe(backing);
      expect([...bytes]).toEqual([4]);
    });
    expect(allocations.mock.calls.filter(([size]) => size === 32)).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('rejects invalid sizes and pre-aborted reads before workspace allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    await writeFile(path, Uint8Array.of(1, 2, 3));
    const allocations = vi.spyOn(Buffer, 'allocUnsafe'), read = createLocalFileReader(2), consume = vi.fn();
    await expect(read(path, undefined, consume)).rejects.toThrow('byte budget');
    await expect(read(path, 3, consume)).rejects.toThrow('byte budget');
    const abort = new AbortController(); abort.abort();
    await expect(read(path, undefined, consume, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(consume).not.toHaveBeenCalled();
    expect(allocations.mock.calls.filter(([size]) => size === 2)).toHaveLength(0);
    expect(() => createLocalFileReader(NaN)).toThrow('byte budget');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('releases the lease after missing files, truncated reads, changed files and consumer errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    const read = createLocalFileReader(8), consume = vi.fn();
    await expect(read(path, 3, consume)).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(path, Uint8Array.of(1, 2, 3));
    hooks.beforeRead = async () => { hooks.beforeRead = undefined; await truncate(path, 0); };
    await expect(read(path, 3, consume)).rejects.toThrow('Short local file read');
    await writeFile(path, Uint8Array.of(1, 2, 3));
    hooks.beforeRead = async () => { hooks.beforeRead = undefined; await utimes(path, new Date(), new Date(Date.now() + 10_000)); };
    await expect(read(path, 3, consume)).rejects.toThrow('changed during read');
    expect(consume).not.toHaveBeenCalled();
    const error = new Error('consumer failed');
    await expect(read(path, 3, async () => { throw error; })).rejects.toBe(error);
    await expect(read(path, 3, bytes => [...bytes])).resolves.toEqual([1, 2, 3]);
    expect(hooks.closes).toBe(4);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('closes an aborted read and preserves close failures before consuming bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    await writeFile(path, Uint8Array.of(1, 2, 3));
    const read = createLocalFileReader(8), consume = vi.fn(), abort = new AbortController();
    hooks.afterRead = () => abort.abort();
    await expect(read(path, 3, consume, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
    hooks.afterRead = undefined;
    hooks.closeError = new Error('close failed');
    await expect(read(path, 3, consume)).rejects.toBe(hooks.closeError);
    hooks.closeError = undefined;
    expect(consume).not.toHaveBeenCalled();
    await expect(read(path, 3, bytes => bytes.length)).resolves.toBe(3);
    expect(hooks.closes).toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('holds an aborted consumer lease until it settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'av-local-file-')), path = join(root, 'artifact');
  try {
    await writeFile(path, Uint8Array.of(1, 2, 3));
    const read = createLocalFileReader(8), abort = new AbortController();
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = read(path, 3, async () => { entered(); await held; }, abort.signal);
    await started; abort.abort();
    await expect(read(path, 3, () => undefined)).rejects.toThrow('buffer is in use');
    release();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await expect(read(path, 3, bytes => bytes.length)).resolves.toBe(3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
