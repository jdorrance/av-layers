import { MAX_SAMPLE_RANGE_BYTES } from '@av/contracts';
import { ensureLive, fail } from './http';
import { binaryRead, countRead, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST, readObjectBytes, type WaitContext } from './resources';

interface ByteRange { offset: number; length: number }
interface Pack { key: string; bytes: number }
export interface PackedRange extends ByteRange { shard: Pack & { sha256: string } }

const rangeMessages = {
  sample: { missing: 'Sample shard missing or invalid', mismatch: 'Sample shard metadata or range mismatch' },
  profile: { missing: 'Profile data is missing', mismatch: 'Profile data metadata or range mismatch' }
};
type RangeKind = keyof typeof rangeMessages;

function validatedRangeLength(range: ByteRange, pack: Pack, kind: RangeKind): number {
  const { offset, length } = range;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
    || !Number.isSafeInteger(offset + length) || offset < 0 || length < 1 || offset + length > pack.bytes) {
    fail(503, 'publication-invalid', `Invalid ${kind} range`);
  }
  return length;
}

async function readPackedRange(
  bucket: R2Bucket, ctx: WaitContext, signal: AbortSignal, expiresAt: string, kind: RangeKind,
  range: PackedRange
): Promise<Uint8Array> {
  const { shard: pack, offset, length } = range;
  const key = `${pack.key}:${pack.sha256}:${offset}:${length}`;
  const bytes = await binaryRead(bucket, key, async ownerSignal => {
    countRead(ctx);
    const object = await bucket.get(pack.key, { range: { offset, length } });
    if (!object || !('body' in object)) fail(503, 'publication-incomplete', rangeMessages[kind].missing);
    if (object.size !== pack.bytes || object.customMetadata?.sha256 !== pack.sha256 || !object.range
      || !('offset' in object.range) || object.range.offset !== offset || !('length' in object.range) || object.range.length !== length) {
      void object.body.cancel().catch(() => {});
      fail(503, 'publication-incomplete', rangeMessages[kind].mismatch);
    }
    return readObjectBytes(object, length, true, ctx, ownerSignal);
  }, ctx, signal);
  ensureLive(expiresAt);
  if (bytes.byteLength !== length) fail(503, 'publication-incomplete', `Incomplete ${kind} range`);
  return bytes;
}

/** Validate and execute a request's selected v5 ranges before passing bytes to its decoder. */
export async function readPackedRanges<T extends PackedRange>(
  bucket: R2Bucket, ctx: WaitContext, signal: AbortSignal, expiresAt: string, kind: RangeKind,
  ranges: readonly T[], consume: (range: T, bytes: Uint8Array) => void
): Promise<void> {
  let total = 0;
  for (const range of ranges) total += validatedRangeLength(range, range.shard, kind);
  if (total > MAX_SAMPLE_RANGE_BYTES) fail(429, 'sample-limit', `Selected ${kind} ranges exceed the byte budget`);

  let next = 0, failure: { error: unknown } | undefined;
  const work = async () => {
    while (!failure && next < ranges.length) {
      const selected = ranges[next++]!;
      try {
        const bytes = await readPackedRange(bucket, ctx, signal, expiresAt, kind, selected);
        consume(selected, bytes);
      } catch (error) { failure ??= { error }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(ranges.length, MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST) }, work));
  if (failure) throw failure.error;
  signal.throwIfAborted();
}
