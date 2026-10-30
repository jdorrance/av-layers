import { sampleFieldValuesAsync } from '@azohra/meteo.grib';
import { createNodeJ2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import { NoaaError } from './errors.ts';
import type { InspectedGfsField } from './admission.ts';

export function compactNoaaSamples<T extends Float32Array | Float64Array = Float64Array>(values: ArrayLike<number>, mask: ArrayLike<number> | undefined, count: number, destination?: T) {
  if (values.length !== count || (mask && mask.length !== count)) {
    throw new NoaaError('decode', 'Decoded sample or mask count differs from requested cells');
  }
  const compact = destination ?? new Float64Array(count) as T;
  if (compact.length !== count) throw new NoaaError('decode', 'Compaction destination has wrong length');
  const missing = new Uint8Array(count);
  let missingCount = 0;
  for (let i = 0; i < count; i++) {
    const value = values[i]!;
    if (mask?.[i] === 1 || !Number.isFinite(value)) {
      compact[i] = Number.NaN;
      missing[i] = 1;
      missingCount++;
    } else compact[i] = value;
  }
  return { values: compact, missing, missingCount };
}

export interface FieldSamplingStats { records: number; failures: number; decodeMs: number; compactMs: number; sampledValues: number }

export class NoaaFieldSampler {
  private pool: ReturnType<typeof createNodeJ2kDecoderPool> | undefined;
  private closed = false;
  private closing?: Promise<void>;
  readonly stats: Record<string, FieldSamplingStats> = {};

  async sample<T extends Float32Array | Float64Array = Float64Array>(inspected: InspectedGfsField, indices: Uint32Array, destination?: T) {
    if (this.closed) throw new NoaaError('decode', 'Field sampler is closed');
    const stats = this.stats[String(inspected.packing)] ??= { records: 0, failures: 0, decodeMs: 0, compactMs: 0, sampledValues: 0 };
    const started = performance.now();
    let decodedAt = started;
    try {
      // Store the promise before awaiting: concurrent first-use shares one pool.
      const pool = inspected.packing === 40 ? await (this.pool ??= createNodeJ2kDecoderPool({ size: 2 })) : undefined;
      if (this.closed) throw new NoaaError('decode', 'Field sampler is closed');
      const sampled = await sampleFieldValuesAsync(inspected.field, indices, {
        missingValue: Number.NaN,
        ...(pool ? { decodeJ2k: pool.decode, decodeJ2kSampled: pool.decodeSampled } : {}),
      });
      decodedAt = performance.now();
      if (this.closed) throw new NoaaError('decode', 'Field sampler is closed');
      const result = compactNoaaSamples(sampled.values, sampled.missingMask, indices.length, destination);
      stats.records++;
      stats.sampledValues += indices.length;
      return result;
    } catch (error) {
      stats.failures++;
      if (decodedAt === started) decodedAt = performance.now();
      throw error;
    } finally {
      stats.decodeMs += decodedAt - started;
      stats.compactMs += performance.now() - decodedAt;
    }
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= (async () => { if (this.pool) await (await this.pool).close(); })();
  }
}
