import z from 'zod';
import { MAX_JSON_CONTAINER_ENTRIES, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, parseBoundedJson, sourceIntervalHours } from '@av/contracts';
import { runConcurrent } from '../concurrent.js';
import type { ForecastSourcePin, ForecastSourceStore } from '../provider.js';
import { isPrivateUpstreamKey } from '../source.js';
import { IndexedGribError } from './errors.ts';
import { indexedGribCompanionSpecs, indexedGribFileUrl, validateCycle } from './fields.ts';
import type { IndexedSource } from './source.js';
import { MAX_NOAA_INDEX_BYTES, sha256 } from './transport.ts';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const etag = z.string().regex(/^"[a-f0-9]{32}(?:-[1-9][0-9]*)?"$/);
const key = z.string().min(1).max(1024);
const readyFileSchema = z.strictObject({ key, bytes: z.number().int().positive(), sha256: digest, etag,
  idxKey: key, idxBytes: z.number().int().positive().max(MAX_NOAA_INDEX_BYTES), idxSha256: digest, idxEtag: etag });
const cycle = z.iso.datetime();
export const upstreamReadySchema = z.strictObject({ version: z.literal(1), model: z.string(), cycle,
  createdAt: z.iso.datetime(), hours: z.array(z.number().int().nonnegative()).min(1).max(MAX_JSON_CONTAINER_ENTRIES),
  files: z.array(readyFileSchema).min(1).max(MAX_JSON_CONTAINER_ENTRIES) });
const latestSchema = z.strictObject({ version: z.literal(1), model: z.string(), cycle, readyKey: key, readySha256: digest });

export interface IndexedR2Object { key: string; bytes: number; sha256: string; etag: string; index: boolean }
export interface IndexedR2Run {
  cycle: string;
  pin: ForecastSourcePin;
  store: ForecastSourceStore;
  objects: ReadonlyMap<string, IndexedR2Object>;
}

function unavailable(key: string): never {
  throw new IndexedGribError('transport', `Private Indexed GRIB source is unavailable: ${key}`, { reason: 'upstream-not-ready', status: 404 });
}

function conflict(message: string): never {
  throw new IndexedGribError('source-conflict', message);
}

function expectedFiles(source: IndexedSource, cycle: string) {
  const keys = new Set<string>(), hours = new Set<number>();
  const add = (hour: number, product: string) => {
    hours.add(hour);
    keys.add(indexedGribFileUrl(source, cycle, hour, product).slice('r2://'.length));
  };
  for (const hour of source.model.forecast.hours) {
    for (const product of Object.values(source.upstream.products)) add(hour, product);
    for (const companion of indexedGribCompanionSpecs(source, hour)) {
      add(hour - sourceIntervalHours(source.model.forecast, hour), source.upstream.products[companion.product]!);
    }
  }
  return { keys, hours: [...hours].sort((a, b) => a - b) };
}

/** Resolve the cycle receipt once. A frozen build reads the exact key and SHA-256 in its plan. */
export async function readIndexedR2Run(source: IndexedSource, options: {
  cycle?: string; sourcePin?: ForecastSourcePin; store?: ForecastSourceStore; signal?: AbortSignal;
}): Promise<IndexedR2Run> {
  const { store, sourcePin, signal } = options;
  if (!store) throw new IndexedGribError('invalid-option', 'Private Indexed GRIB requires R2 storage');
  if (sourcePin && !options.cycle) throw new IndexedGribError('invalid-option', 'Pinned Indexed GRIB receipt requires a cycle');
  const model = source.model.modelId, root = `upstream/${model}/`;
  let latest: z.infer<typeof latestSchema> | undefined;
  if (options.cycle === undefined) {
    const key = `${root}latest.json`, object = await store.get(key, undefined, 4096, signal);
    if (!object) unavailable(key);
    if (object.bytes.byteLength > 4096) conflict('Private Indexed GRIB latest pointer exceeds its byte budget');
    latest = latestSchema.parse(parseBoundedJson(object.bytes));
    if (latest.model !== model) conflict('Private Indexed GRIB latest pointer has a different model');
  }
  const cycle = validateCycle(source, options.cycle ?? latest!.cycle);
  const prefix = `${root}${cycle.slice(0, 10).replaceAll('-', '')}/${cycle.slice(11, 13)}/`;
  const key = `${prefix}_ready.json`;
  if ((sourcePin && sourcePin.key !== key) || (latest && latest.readyKey !== key)) conflict('Private Indexed GRIB receipt key differs from its cycle');
  const maxBytes = sourcePin?.bytes ?? MAX_MANIFEST_BYTES;
  const object = await store.get(key, undefined, maxBytes, signal);
  if (!object) unavailable(key);
  const bytes = object.bytes.byteLength, hash = sha256(object.bytes);
  if (bytes > maxBytes || (sourcePin && (bytes !== sourcePin.bytes || hash !== sourcePin.sha256)) || (latest && hash !== latest.readySha256)) {
    conflict('Private Indexed GRIB receipt changed after admission');
  }
  const receipt = upstreamReadySchema.parse(parseBoundedJson(object.bytes, MAX_MANIFEST_JSON_TOKENS));
  if (receipt.model !== model || validateCycle(source, receipt.cycle) !== cycle) conflict('Private Indexed GRIB receipt has a different model or cycle');
  const expected = expectedFiles(source, cycle);
  if (receipt.hours.length !== expected.hours.length || receipt.hours.some((hour, index) => hour !== expected.hours[index])
      || receipt.files.length !== expected.keys.size) conflict('Private Indexed GRIB receipt has incomplete or unexpected forecast hours');
  const objects = new Map<string, IndexedR2Object>();
  for (const file of receipt.files) {
    if (!isPrivateUpstreamKey(file.key, prefix) || file.idxKey !== `${file.key}.idx` || !expected.keys.delete(file.key)
        || objects.has(file.key) || objects.has(file.idxKey)) conflict('Private Indexed GRIB receipt has an unexpected or duplicate object');
    objects.set(file.key, { key: file.key, bytes: file.bytes, etag: file.etag, sha256: file.sha256, index: false });
    objects.set(file.idxKey, { key: file.idxKey, bytes: file.idxBytes, etag: file.idxEtag, sha256: file.idxSha256, index: true });
  }
  return { cycle, store, pin: { key, bytes, sha256: hash }, objects };
}

/** Admit immutable object metadata before assigning any compute shards. */
export async function verifyIndexedR2Objects(run: IndexedR2Run, signal?: AbortSignal): Promise<void> {
  await runConcurrent([...run.objects.values()], 8, async expected => {
    signal?.throwIfAborted();
    const head = await run.store.head(expected.key, signal);
    if (!head) unavailable(expected.key);
    if (head.size !== expected.bytes || head.etag !== expected.etag || head.metadata?.sha256 !== expected.sha256
        || (head.computedSha256 !== undefined && head.computedSha256 !== expected.sha256)) {
      conflict(`Private Indexed GRIB object identity differs from its receipt: ${expected.key}`);
    }
  });
}
