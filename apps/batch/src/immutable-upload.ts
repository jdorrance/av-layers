import { createHash } from 'node:crypto';
import type { ObjectStorage } from './storage.js';

/** Retries prove every byte of an existing object; they never overwrite immutable keys. */
export async function putImmutable(store: ObjectStorage, key: string, bytes: Uint8Array, contentType: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const md5 = createHash('md5').update(bytes).digest(), sha = createHash('sha256').update(bytes).digest('hex');
  const proveExisting = async (): Promise<boolean> => {
    signal?.throwIfAborted();
    const head = await store.head(key);
    if (!head) return false;
    if (head.size !== bytes.byteLength) throw new Error(`Immutable object size mismatch: ${key}`);
    const hash = createHash('sha256');
    for (let offset = 0; offset < head.size; offset += 4 * 1024 * 1024) {
      signal?.throwIfAborted();
      const length = Math.min(4 * 1024 * 1024, head.size - offset), part = await store.get(key, { offset, length });
      signal?.throwIfAborted();
      if (!part || part.bytes.byteLength !== length || part.etag !== head.etag) throw new Error(`Immutable object read mismatch: ${key}`);
      hash.update(part.bytes);
    }
    if (hash.digest('hex') !== sha) throw new Error(`Immutable object hash mismatch: ${key}`);
    return true;
  };
  if (await proveExisting()) return;
  signal?.throwIfAborted();
  try { await store.put(key, bytes, { ifNoneMatch: '*' }, contentType, md5.toString('base64')); }
  catch (error) {
    // A timeout can follow a successful create. Reconcile before deciding whether to retry.
    if (await proveExisting()) return;
    throw error;
  }
  signal?.throwIfAborted();
  const head = await store.head(key), etag = `"${md5.toString('hex')}"`;
  if (!head || head.size !== bytes.byteLength || head.etag !== etag) throw new Error(`R2 single-PUT MD5 ETag or size mismatch: ${key}`);
  const length = Math.min(bytes.byteLength, 32), tail = await store.get(key, { offset: bytes.byteLength - length, length });
  if (!tail || tail.etag !== etag || !Buffer.from(tail.bytes).equals(bytes.subarray(bytes.byteLength - length))) throw new Error(`R2 tail or ETag mismatch: ${key}`);
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
