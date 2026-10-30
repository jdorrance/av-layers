import { sampleFieldValuesAsync } from '@azohra/meteo.grib';
import { createNodeJ2kDecoderPool } from '@azohra/meteo.grib/j2k-node';
import { NoaaError } from './errors.ts';
import type { InspectedGfsField } from './admission.ts';

export function compactNoaaSamples(values: ArrayLike<number>, mask: ArrayLike<number> | undefined, count: number) {
  if (values.length !== count || (mask && mask.length !== count)) {
    throw new NoaaError('decode', 'Decoded sample or mask count differs from requested cells');
  }
  const compact = new Float64Array(count);
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

export class NoaaFieldSampler {
  private pool: Awaited<ReturnType<typeof createNodeJ2kDecoderPool>> | undefined;

  async sample(inspected: InspectedGfsField, indices: Uint32Array) {
    if (inspected.packing === 40) this.pool ??= await createNodeJ2kDecoderPool({ size: 2 });
    const sampled = await sampleFieldValuesAsync(inspected.field, indices, {
      missingValue: Number.NaN,
      ...(inspected.packing === 40 && this.pool
        ? { decodeJ2k: this.pool.decode, decodeJ2kSampled: this.pool.decodeSampled }
        : {}),
    });
    return compactNoaaSamples(sampled.values, sampled.missingMask, indices.length);
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.close();
  }
}
