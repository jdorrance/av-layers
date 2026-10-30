# GFS acquisition

This adapter admits NOAA source records and returns native-grid columns with
explicit missing masks, intervals and source receipts. It owns transport,
packing admission and raw-window recovery; forecast science stays in
[`@av/forecast`](../../../../packages/forecast/README.md).

`createGfsAcquisitionSession` in [index.ts](index.ts) shares inventories,
validated index order, bounded fetch-ahead work and raw companion samples for
one build. Its inputs, outputs and lifecycle are declared in [types.ts](types.ts).

```ts
const session = await createGfsAcquisitionSession({ activeIndices, cacheDir, cycle });
try {
  for (const hour of GFS_FORECAST_HOURS) {
    const frame = await session.acquire(hour);
    // Consume or persist the caller-owned arrays and receipts.
  }
} finally {
  await session.close();
}
```

Omitting `cycle` discovers an inventory-complete run using the same transport.
Frames are acquired sequentially; independent source records are fetched ahead
within the configured concurrency and compressed-byte limits. A failure or
abort cancels queued work and closes the decoder. `acquireGfsFrame` remains the
standalone operation and owns an ephemeral session.

Raw interval samples retain Float64 precision until trailing-window recovery.
Instantaneous fields compact directly to their Float32 output. A rolling cache
retains only the three raw fields needed by the next companion window; returned
arrays and receipts cannot mutate that cache.

`session.stats` reports transport/cache counts, per-packing decode and compaction
measurements, raw-companion hits and peak reserved compressed bytes. Load timings
can overlap other work and must not be added as exclusive phase durations. The
compressed-byte budget excludes decoded arrays and runtime/codec memory; measure
whole-job RSS separately. [Operations](../../../../docs/operations.md) owns build
execution and [science](../../../../docs/science.md) owns interpretation.
