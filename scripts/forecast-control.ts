import { mkdir, statfs, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { MAX_MANIFEST_BYTES, MAX_PROVENANCE_BYTES } from '@av/contracts';
import { forecastPlanDeadline, MAX_V5_SHARD_BYTES } from '../apps/batch/src/capacity.js';
import { runConcurrent } from '../apps/batch/src/concurrent.js';
import { putImmutableReceipt } from '../apps/batch/src/immutable-upload.js';
import { localPath, readLocalFile } from '../apps/batch/src/local-file.js';
import { parseForecastShardReceipt, type BuildPlan } from '../apps/batch/src/parallel.js';
import type { ObjectStorage } from '../apps/batch/src/storage.js';
import { sha256 } from '../apps/batch/src/validate.js';

type ControlPlan = Pick<BuildPlan, 'model' | 'buildId' | 'createdAt' | 'deadlineAt' | 'groups'>;

const prefix = (plan: ControlPlan) => `builds/${plan.model}/${plan.buildId}/_control`;
const receiptKey = (plan: ControlPlan, shard: number) => `${prefix(plan)}/shards/${shard}/receipt.json`;

export function forecastPlanSignal(plan: ControlPlan, signal?: AbortSignal): AbortSignal {
  const deadline = forecastPlanDeadline(plan);
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Forecast publication deadline exceeded');
  const timeout = AbortSignal.timeout(remaining);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readControlObject(store: ObjectStorage, key: string, maximum: number, signal: AbortSignal) {
  signal.throwIfAborted();
  const head = await store.head(key, signal);
  if (!head) return null;
  const digest = head.metadata?.sha256;
  if (!Number.isSafeInteger(head.size) || head.size < 1 || head.size > maximum || !digest || !/^[a-f0-9]{64}$/.test(digest)) throw new Error(`Invalid forecast control object: ${key}`);
  const object = await store.get(key, undefined, head.size, signal);
  signal.throwIfAborted();
  if (!object || object.etag !== head.etag || object.bytes.length !== head.size || sha256(object.bytes) !== digest) {
    throw new Error(`Forecast control object integrity mismatch: ${key}`);
  }
  return object.bytes;
}

export async function uploadForecastControlPlan(store: ObjectStorage, root: string, plan: ControlPlan): Promise<void> {
  const signal = forecastPlanSignal(plan);
  await putImmutableReceipt(store, `${prefix(plan)}/plan.json`, await readLocalFile(join(root, 'plan.json'), MAX_MANIFEST_BYTES), 'application/json', signal);
}

async function restoreShardPayload(store: ObjectStorage, root: string, plan: BuildPlan, shard: number, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  const { objects } = parseForecastShardReceipt(bytes, plan, shard);
  if (!objects) throw new Error('Forecast shard receipt has no stored payload');
  const buildPrefix = `builds/${plan.model}/${plan.buildId}/`, keys = new Set<string>();
  let requiredBytes = 0;
  for (const object of objects) {
    const name = object.key.slice(buildPrefix.length);
    if (!object.key.startsWith(buildPrefix) || keys.has(object.key) || name.split('/').some(segment => !/^[a-zA-Z0-9._-]+$/.test(segment) || segment === '.' || segment === '..')) {
      throw new Error('Forecast shard payload key is invalid');
    }
    if (name.startsWith('surfaces/') && object.bytes > MAX_V5_SHARD_BYTES) throw new Error('Forecast shard numeric payload exceeds byte budget');
    keys.add(object.key);
    requiredBytes += object.bytes;
  }
  const disk = await statfs(root);
  if (requiredBytes > disk.bavail * disk.bsize) throw new Error('Insufficient disk for forecast shard payload');
  for (const object of objects) {
    signal.throwIfAborted();
    const stored = await store.get(object.key, undefined, object.bytes, signal, undefined, object);
    signal.throwIfAborted();
    if (!stored || stored.etag !== object.etag || stored.bytes.byteLength !== object.bytes || sha256(stored.bytes) !== object.sha256) {
      throw new Error(`Forecast shard payload integrity mismatch: ${object.key}`);
    }
    const destination = localPath(root, object.key);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, stored.bytes, { flag: 'wx', signal });
  }
}

/** Preserve the first receipt when a job is retried after its immutable upload. */
export async function completeForecastControlShard(store: ObjectStorage, plan: BuildPlan, shard: number,
  path: string, build: () => Promise<string>, signal: AbortSignal, payloadRoot?: string): Promise<void> {
  if (!Number.isSafeInteger(shard) || shard < 0 || shard >= plan.groups.length) throw new Error('Invalid forecast shard');
  const key = receiptKey(plan, shard);
  const existing = await readControlObject(store, key, MAX_PROVENANCE_BYTES, signal);
  if (existing) {
    if (payloadRoot) await restoreShardPayload(store, payloadRoot, plan, shard, existing, signal);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, existing, { flag: 'wx', signal });
    return;
  }
  const file = await build();
  await putImmutableReceipt(store, key, await readLocalFile(file, MAX_PROVENANCE_BYTES), 'application/json', signal);
}

export async function downloadForecastControlReceipts(store: ObjectStorage, root: string, plan: ControlPlan, signal: AbortSignal): Promise<void> {
  const remotePlan = await readControlObject(store, `${prefix(plan)}/plan.json`, MAX_MANIFEST_BYTES, signal);
  const localPlan = await readLocalFile(join(root, 'plan.json'), MAX_MANIFEST_BYTES);
  if (!remotePlan || !localPlan.equals(remotePlan)) throw new Error('R2 forecast control plan differs from the workflow plan');
  await runConcurrent(plan.groups.map((_, shard) => shard), 4, async shard => {
    const key = receiptKey(plan, shard);
    const bytes = await readControlObject(store, key, MAX_PROVENANCE_BYTES, signal);
    if (!bytes) throw new Error(`Missing forecast shard receipt: ${key}`);
    const directory = join(root, 'shards', String(shard));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'receipt.json'), bytes, { flag: 'wx', signal });
  });
}
