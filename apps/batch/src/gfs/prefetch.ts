import { NoaaError } from './errors.ts';

/** Ordered consumption keeps scientific/provenance order while fetching ahead.
 * Reservations include completed buffers until the consumer advances. */
export async function* prefetchFields<T, R>(
  items: readonly T[],
  bytes: (item: T) => number,
  load: (item: T) => Promise<R>,
  options: {
    concurrency: number;
    maxBytes: number;
    signal: AbortSignal;
    fail: (error: unknown) => void;
    peak: (bytes: number) => void;
  }
): AsyncGenerator<R> {
  const pending: { bytes: number; result: Promise<{ ok: true; value: R } | { ok: false; error: unknown }> }[] = [];
  let next = 0, reserved = 0;
  const pump = () => {
    options.signal.throwIfAborted();
    for (; next < items.length && pending.length < options.concurrency; next++) {
      const item = items[next]!, size = bytes(item);
      if (!Number.isSafeInteger(size) || size <= 0 || size > options.maxBytes) {
        throw new NoaaError('transport', `GRIB record exceeds prefetch byte budget (${size} > ${options.maxBytes})`);
      }
      if (reserved + size > options.maxBytes) break;
      reserved += size;
      options.peak(reserved);
      pending.push({
        bytes: size,
        result: load(item).then(
          value => ({ ok: true as const, value }),
          error => { options.fail(error); return { ok: false as const, error }; }
        )
      });
    }
  };
  try {
    pump();
    for (let current = pending[0]; current; current = pending[0]) {
      const result = await current.result;
      if (!result.ok) throw result.error;
      options.signal.throwIfAborted();
      yield result.value;
      pending.shift();
      reserved -= current.bytes;
      pump();
    }
  } finally {
    if (pending.length && !options.signal.aborted) {
      options.fail(new NoaaError('decode', 'Acquisition prefetch stopped before completion'));
    }
    await Promise.all(pending.map(item => item.result));
  }
}
