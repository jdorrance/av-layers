import { MAX_SAMPLE_RANGE_BYTES } from '@av/contracts';
import { ensureLive, fail } from './http';
import { binaryRead, countRead, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST, readObjectBytes, type WaitContext } from './resources';

export interface PackedRange {
  shard: { key: string; sha256: string; bytes: number };
  offset: number;
  length: number;
}

const rangeMessages = {
  sample: { missing: 'Sample shard missing or invalid', mismatch: 'Sample shard metadata or range mismatch' },
  profile: { missing: 'Profile data is missing', mismatch: 'Profile data metadata or range mismatch' }
};

/** Validate and execute a request's selected v5 ranges before passing bytes to its decoder. */
export async function readPackedRanges<T extends PackedRange>(
  bucket: R2Bucket, ctx: WaitContext, signal: AbortSignal, expiresAt: string, kind: keyof typeof rangeMessages,
  ranges: readonly T[], consume: (range: T, bytes: Uint8Array) => void
): Promise<void> {
  const { missing, mismatch } = rangeMessages[kind];
  let total = 0;
  for (const { shard, offset, length } of ranges) {
    if (!shard || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || !Number.isSafeInteger(offset + length) || offset < 0 || length < 1 || offset + length > shard.bytes) {
      fail(503, 'publication-invalid', `Invalid ${kind} range`);
    }
    total += length;
  }
  if (total > MAX_SAMPLE_RANGE_BYTES) fail(429, 'sample-limit', `Selected ${kind} ranges exceed the byte budget`);

  let next = 0, failure: { error: unknown } | undefined;
  const work = async () => {
    while (!failure && next < ranges.length) {
      const selected = ranges[next++]!, { shard, offset, length } = selected;
      try {
        const bytes = await binaryRead(bucket, `${shard.key}:${shard.sha256}:${offset}:${length}`, async ownerSignal => {
          countRead(ctx);
          const object = await bucket.get(shard.key, { range: { offset, length } });
          if (!object || !('body' in object)) fail(503, 'publication-incomplete', missing);
          if (object.size !== shard.bytes || object.customMetadata?.sha256 !== shard.sha256 || !object.range
            || !('offset' in object.range) || object.range.offset !== offset || !('length' in object.range) || object.range.length !== length) {
            void object.body.cancel().catch(() => {});
            fail(503, 'publication-incomplete', mismatch);
          }
          return readObjectBytes(object, length, true, ctx, ownerSignal);
        }, ctx, signal);
        ensureLive(expiresAt);
        if (bytes.byteLength !== length) fail(503, 'publication-incomplete', `Incomplete ${kind} range`);
        consume(selected, bytes);
      } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ranges.length, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST) }, work));
  if (failure) throw failure.error;
  signal.throwIfAborted();
}
