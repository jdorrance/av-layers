/** Stop admitting work on failure and drain every admitted operation. */
export async function runConcurrent<T>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<void>): Promise<void> {
  const iterator = items.values();
  let failed = false, failure: unknown;
  const worker = async (): Promise<void> => {
    for (const item of iterator) {
      if (failed) return;
      try { await fn(item); }
      catch (error) { if (!failed) { failed = true; failure = error; } return; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
}
