import { createHash } from 'node:crypto';
import type { ObjectStorage } from './storage.js';

export interface ObjectReceipt { key: string; bytes: number; sha256: string; etag: string }

export async function verifyObjectReceipts(store: Pick<ObjectStorage, 'head'>, receipts: readonly ObjectReceipt[], signal?: AbortSignal): Promise<void> {
  const keys = new Set<string>();
  for (const receipt of receipts) {
    if (keys.has(receipt.key) || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 1 || !/^[a-f0-9]{64}$/.test(receipt.sha256) || !receipt.etag) throw new Error('Invalid object receipt');
    keys.add(receipt.key);
    const head = await store.head(receipt.key, signal);
    if (!head || head.size !== receipt.bytes || head.etag !== receipt.etag || head.metadata?.sha256 !== receipt.sha256) throw new Error(`Remote object receipt mismatch: ${receipt.key}`);
  }
}

/** Retries prove every byte of an existing object; they never overwrite immutable keys. */
export async function putImmutable(store: Pick<ObjectStorage, 'get' | 'head' | 'put'>, key: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal, requireDigestMetadata = false): Promise<void> {
  signal?.throwIfAborted();
  const md5 = createHash('md5').update(bytes).digest(), sha = createHash('sha256').update(bytes).digest('hex');
  const proveExisting = async (): Promise<boolean> => {
    signal?.throwIfAborted();
    const head = await store.head(key, signal);
    if (!head) return false;
    if (head.size !== bytes.byteLength) throw new Error(`Immutable object size mismatch: ${key}`);
    if (requireDigestMetadata && head.metadata?.sha256 !== sha) throw new Error(`Immutable object digest metadata mismatch: ${key}`);
    const hash = createHash('sha256');
    for (let offset = 0; offset < head.size; offset += 4 * 1024 * 1024) {
      signal?.throwIfAborted();
      const length = Math.min(4 * 1024 * 1024, head.size - offset), part = await store.get(key, { offset, length }, length, signal);
      signal?.throwIfAborted();
      if (!part || part.bytes.byteLength !== length || part.etag !== head.etag) throw new Error(`Immutable object read mismatch: ${key}`);
      hash.update(part.bytes);
    }
    if (hash.digest('hex') !== sha) throw new Error(`Immutable object hash mismatch: ${key}`);
    return true;
  };
  const existing = await proveExisting();
  if (existing) return;
  signal?.throwIfAborted();
  try { await store.put(key, bytes, { ifNoneMatch: '*' }, contentType, md5.toString('base64'), { sha256: sha }); }
  catch (error) {
    // A timeout can follow a successful create. Reconcile before deciding whether to retry.
    const existing = await proveExisting();
    if (existing) return;
    throw error;
  }
  signal?.throwIfAborted();
  const head = await store.head(key, signal), etag = `"${md5.toString('hex')}"`;
  if (!head || head.size !== bytes.byteLength || head.etag !== etag) throw new Error(`R2 single-PUT MD5 ETag or size mismatch: ${key}`);
  if (requireDigestMetadata && head.metadata?.sha256 !== sha) throw new Error(`Immutable object digest metadata mismatch: ${key}`);
  const length = Math.min(bytes.byteLength, 32), tail = await store.get(key, { offset: bytes.byteLength - length, length }, length, signal);
  if (!tail || tail.etag !== etag || !Buffer.from(tail.bytes).equals(bytes.subarray(bytes.byteLength - length))) throw new Error(`R2 tail or ETag mismatch: ${key}`);
}

export async function putImmutableReceipt(store: Pick<ObjectStorage, 'get' | 'head' | 'put'>, key: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<ObjectReceipt> {
  await putImmutable(store, key, bytes, contentType, signal, true);
  const head = await store.head(key, signal), digest = createHash('sha256').update(bytes).digest('hex');
  if (!head || head.size !== bytes.length || head.metadata?.sha256 !== digest) throw new Error(`Immutable object receipt mismatch: ${key}`);
  return { key, bytes: bytes.length, sha256: digest, etag: head.etag };
}

/** Reservations include the file and an SDK/transport copy; stop admission and drain on failure. */
export async function uploadBounded<T extends { size: number }>(items: readonly T[], limitBytes: number, run: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) throw new Error('Invalid upload byte budget');
  if (items.some(item => !Number.isSafeInteger(item.size * 2) || item.size <= 0 || item.size * 2 > limitBytes)) throw new Error('Upload reservation exceeds byte budget');
  const jobs = new Set<Promise<void>>();
  let reserved = 0, failed = false, failure: unknown;
  for (const item of items) {
    const charge = item.size * 2;
    while (!failed && (jobs.size >= 4 || reserved + charge > limitBytes)) await Promise.race(jobs);
    if (failed) break;
    reserved += charge;
    const job = Promise.resolve().then(() => run(item)).catch(error => { if (!failed) { failed = true; failure = error; } }).finally(() => { reserved -= charge; jobs.delete(job); });
    jobs.add(job);
  }
  await Promise.all(jobs);
  if (failed) throw failure;
}
