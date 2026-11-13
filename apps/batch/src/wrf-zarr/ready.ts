import { createHash } from 'node:crypto';
import z from 'zod';
import { gridSchema, sameGrid, MAX_MANIFEST_BYTES, MAX_MANIFEST_JSON_TOKENS, MAX_SAMPLE_VALUES, parseBoundedJson, sourceIntervalHours, type ModelDefinition } from '@av/contracts';
import contract from '../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json' with { type: 'json' };
import { forecastSourcePinSchema, type ForecastSourcePin, type ForecastSourceStore } from '../provider.js';
import { privateUpstreamPrefix, sourceCycle, sourceCycleParts } from '../source.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/), timestamp = z.iso.datetime();
const times = z.array(timestamp).min(1).max(MAX_SAMPLE_VALUES);
const receiptSchema = z.strictObject({
  schema_id: z.literal(contract.schemaId), schema_version: z.literal(contract.schemaVersion),
  model_id: z.string(), cycle_partition: z.string(), publish_origin_utc: timestamp,
  attempt_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  zarr_relpath: z.string().max(256), grid: gridSchema,
  exported_levels_k: z.number().int().positive().max(contract.maxVerticalLevels),
  lead_hours: z.array(z.number().int().positive()).min(1).max(MAX_SAMPLE_VALUES),
  valid_times_utc: times, window_starts_utc: times, window_ends_utc: times,
  field_names: z.array(z.string()).length(contract.fields.length),
  shard_sha256s: z.array(z.tuple([z.string(), digest])).min(1).max(8192),
  config_sha256: digest, forcing_profile_id: z.string().min(1), oci_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  diagnostics_sha256: digest.optional()
});
const latestSchema = z.object({ model_id: z.string(), cycle_partition: z.string(), publish_origin_utc: timestamp, ready_key: z.string() });
export const COORDINATES = ['time', 'valid_time_unix_s', 'window_start_unix_s', 'window_end_unix_s', 'level', 'y', 'x'] as const;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export function shardKey(field: typeof contract.fields[number], index: number): string {
  return `${field.name}/c/${field.dims.length === 2 ? '0/0' : field.dims.length === 3 ? `${index}/0/0` : `${index}/0/0/0`}`;
}

/** Admit the producer's immutable inventory and bind configured frames to its clocks. */
export async function readRun(model: ModelDefinition, options: {
  cycle?: string; sourcePin?: ForecastSourcePin; store?: ForecastSourceStore; signal?: AbortSignal;
}) {
  const { store, signal } = options;
  if (!store) throw new Error('WRF Zarr requires source storage');
  const pin = options.sourcePin && forecastSourcePinSchema.parse(options.sourcePin);
  if (pin && !options.cycle) throw new Error('Pinned WRF receipt requires an explicit cycle');
  let latest: z.infer<typeof latestSchema> | undefined;
  if (!options.cycle) {
    const key = `${privateUpstreamPrefix(model.modelId)}latest.json`, object = await store.get(key, undefined, 4096, signal);
    if (!object) throw new Error(`WRF latest pointer unavailable: ${key}; select --cycle explicitly`);
    if (object.bytes.length > 4096) throw new Error('WRF latest pointer exceeds byte budget');
    latest = latestSchema.parse(parseBoundedJson(object.bytes));
  }
  const cycle = sourceCycle(options.cycle ?? latest!.publish_origin_utc, model.forecast.cycleHoursUtc);
  const parts = sourceCycleParts(cycle), partition = `${parts.date}/${parts.cycleHour}`;
  const prefix = privateUpstreamPrefix(model.modelId, parts), key = `${prefix}_ready.json`;
  if ((pin && pin.key !== key) || (latest && (latest.model_id !== model.modelId || latest.cycle_partition !== partition || latest.ready_key !== key))) {
    throw new Error('WRF receipt key differs from its model or cycle');
  }
  const object = await store.get(key, undefined, pin?.bytes ?? MAX_MANIFEST_BYTES, signal);
  if (!object) throw new Error(`WRF receipt unavailable: ${key}`);
  const bytes = object.bytes.length, hash = sha256(object.bytes);
  if (bytes > MAX_MANIFEST_BYTES || (pin && (bytes !== pin.bytes || hash !== pin.sha256))) throw new Error('WRF receipt changed after admission');
  // A 48-frame producer receipt commits 1,046 objects; serving metadata retains its smaller default limit.
  const receipt = receiptSchema.parse(parseBoundedJson(object.bytes, MAX_MANIFEST_JSON_TOKENS, 8192));
  const hostedPath = /^attempts\/([^/]+)\/[a-f0-9]{64}\/forecast\.zarr$/.exec(receipt.zarr_relpath);
  if (receipt.zarr_relpath !== 'forecast.zarr' && (!hostedPath || hostedPath[1] !== receipt.attempt_id)) throw new Error('WRF payload path differs from its admitted attempt');
  if (receipt.model_id !== model.modelId || receipt.cycle_partition !== partition || sourceCycle(receipt.publish_origin_utc) !== cycle
      || !sameGrid(receipt.grid, model.grid) || receipt.exported_levels_k !== model.capabilities.maxVerticalLevels) {
    throw new Error('WRF receipt model, cycle, grid or vertical levels differ from configuration');
  }
  const hours = receipt.lead_hours;
  if (hours.some((hour, i) => i > 0 && hour <= hours[i - 1]!) || model.frameHours.some(hour => !hours.includes(hour))
      || [receipt.valid_times_utc, receipt.window_starts_utc, receipt.window_ends_utc].some(values => values.length !== hours.length)) {
    throw new Error('WRF receipt has incomplete or unordered forecast hours');
  }
  for (const [i, hour] of hours.entries()) {
    const valid = Date.parse(cycle) + hour * 3_600_000, start = Date.parse(cycle) + (hours[i - 1] ?? 0) * 3_600_000;
    if (Date.parse(receipt.valid_times_utc[i]!) !== valid || Date.parse(receipt.window_ends_utc[i]!) !== valid
        || Date.parse(receipt.window_starts_utc[i]!) !== start) {
      throw new Error('WRF receipt has inconsistent time windows');
    }
  }
  const windowIndices = new Map<number, number[]>();
  for (const hour of model.frameHours) {
    const start = Date.parse(cycle) + (hour - sourceIntervalHours(model, hour)) * 3_600_000;
    const first = receipt.window_starts_utc.findIndex(value => Date.parse(value) === start), last = hours.indexOf(hour);
    if (first < 0 || first > last) throw new Error('WRF source windows do not cover the configured interval');
    windowIndices.set(hour, Array.from({ length: last - first + 1 }, (_, i) => first + i));
  }
  if (contract.fields.some((field, i) => receipt.field_names[i] !== field.name)) throw new Error('WRF field inventory differs from the wire contract');
  const expected = new Set(['zarr.json', ...COORDINATES.flatMap(name => [`${name}/zarr.json`, `${name}/c/0`]),
    ...contract.fields.flatMap(field => [`${field.name}/zarr.json`, ...(field.dims.length === 2 ? [shardKey(field, 0)] : hours.map((_, i) => shardKey(field, i)))])]);
  const hashes = new Map<string, string>();
  for (const [name, hash] of receipt.shard_sha256s) {
    if (!expected.delete(name)) throw new Error(`Unexpected or duplicate WRF object: ${name}`);
    hashes.set(name, hash);
  }
  if (expected.size) throw new Error('WRF receipt has an incomplete object inventory');
  return { cycle, receipt, windowIndices, pin: { key, bytes, sha256: hash },
    async read(name: string, maximum: number): Promise<Uint8Array> {
      signal?.throwIfAborted();
      const hash = hashes.get(name);
      if (!hash) throw new Error(`Uncommitted WRF object: ${name}`);
      const object = await store.get(`${prefix}${receipt.zarr_relpath}/${name}`, undefined, maximum, signal);
      signal?.throwIfAborted();
      if (!object || object.bytes.length > maximum || sha256(object.bytes) !== hash) throw new Error(`WRF object missing, oversized or SHA-256 mismatch: ${name}`);
      return object.bytes;
    }
  };
}
export type WrfRun = Awaited<ReturnType<typeof readRun>>;
