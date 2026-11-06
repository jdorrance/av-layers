import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { putImmutableReceipt, verifyObjectReceipts, type ObjectReceipt } from './immutable-upload.js';

it('returns the upload proof without another HEAD or body read, including on resume', async () => {
  const bytes = Buffer.from('immutable numeric data'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const receipt = { key: 'data', bytes: bytes.length, sha256, etag: `"${createHash('md5').update(bytes).digest('hex')}"` };
  let exists = false;
  const store = {
    head: vi.fn(async () => exists ? { size: bytes.length, etag: receipt.etag, metadata: { sha256 } } : null),
    put: vi.fn(async () => { exists = true; }),
    get: vi.fn(async () => ({ bytes, etag: receipt.etag }))
  };
  expect(await putImmutableReceipt(store, 'data', bytes, 'application/octet-stream', undefined, sha256)).toEqual(receipt);
  expect(store.head).toHaveBeenCalledTimes(2);
  expect(store.get).toHaveBeenCalledOnce();
  store.head.mockClear(); store.get.mockClear(); store.put.mockClear();
  expect(await putImmutableReceipt(store, 'data', bytes, 'application/octet-stream', undefined, sha256)).toEqual(receipt);
  expect(store.head).toHaveBeenCalledOnce();
  expect(store.get).toHaveBeenCalledExactlyOnceWith('data', { offset: 0, length: bytes.length }, bytes.length, undefined);
  expect(store.put).not.toHaveBeenCalled();
});

it('checks the expected byte digest before any remote operation', async () => {
  const bytes = Buffer.from('changed local serving data'), store = { head: vi.fn(), get: vi.fn(), put: vi.fn() };
  await expect(putImmutableReceipt(store, 'data', bytes, 'application/octet-stream', undefined, 'a'.repeat(64))).rejects.toThrow('Local hash mismatch');
  expect(store.head).not.toHaveBeenCalled(); expect(store.get).not.toHaveBeenCalled(); expect(store.put).not.toHaveBeenCalled();
});

it('still proves every existing remote byte when the expected local digest matches', async () => {
  const bytes = Buffer.from('known local data'), sha256 = createHash('sha256').update(bytes).digest('hex');
  const store = { head: vi.fn(async () => ({ size: bytes.length, etag: 'existing', metadata: { sha256 } })),
    get: vi.fn(async () => ({ bytes: Buffer.alloc(bytes.length), etag: 'existing' })), put: vi.fn() };
  await expect(putImmutableReceipt(store, 'data', bytes, 'application/octet-stream', undefined, sha256)).rejects.toThrow('Immutable object hash mismatch');
  expect(store.get).toHaveBeenCalledOnce(); expect(store.put).not.toHaveBeenCalled();
});

const receipts: ObjectReceipt[] = Array.from({ length: 12 }, (_, index) => ({ key: String(index), bytes: 10, sha256: 'a'.repeat(64), etag: 'etag' }));
it('validates the entire receipt set before any storage call', async () => {
  const head = vi.fn(async () => null);
  await expect(verifyObjectReceipts({ head }, [...receipts, receipts[0]!])).rejects.toThrow('Invalid object receipt');
  expect(head).not.toHaveBeenCalled();
});

it('bounds metadata checks to four and drains admitted checks after failure', async () => {
  let release!: () => void, active = 0, peak = 0, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const head = vi.fn(async (key: string) => {
    active++; peak = Math.max(peak, active);
    try {
      if (key === '0') throw new Error('HEAD failed');
      await gate;
      return { size: 10, etag: 'etag', metadata: { sha256: 'a'.repeat(64) } };
    } finally { active--; }
  });
  const result = verifyObjectReceipts({ head }, receipts).catch(error => error).finally(() => { settled = true; });
  await vi.waitFor(() => expect(head).toHaveBeenCalledTimes(4));
  expect(settled).toBe(false);
  expect(peak).toBeLessThanOrEqual(4);
  release();
  expect(await result).toMatchObject({ message: 'HEAD failed' });
  expect(head).toHaveBeenCalledTimes(4);
  expect(active).toBe(0);
});
