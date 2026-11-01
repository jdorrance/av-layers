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
Frames are acquired sequentially; independent source records are fetched and
decoded ahead within the configured concurrency and working-byte limits. A
failure or abort cancels queued work, drains started work and closes the decoder.
`acquireGfsFrame` remains the
standalone operation and owns an ephemeral session.

Production defaults are two fetch jobs, one J2K worker and a 128 MiB reservation
budget. Each reservation includes copied source and index buffers, decode
workspace, worker overhead and the retained result until consumption. Explicit
J2K worker counts from one to four are supported; the reference benchmark's
records all use packing 3, so it does not establish a J2K concurrency speedup.
The existing `meteo.j2k` decoder remains in use.

[Transport](transport.ts) bounds indexes to 1 MiB and individual records to
128 MiB, including streamed responses and cache reads. Transient network errors,
408, 429 and selected 5xx responses receive at most three attempts inside a
120-second deadline by default. Retry-After and jittered backoff are bounded;
size, range and identity conflicts fail immediately. A missing selected inventory
record triggers one explicit inventory refresh. Only unavailable/incomplete runs
permit discovery to try an older cycle; conflicting source metadata never does.

Raw interval samples retain Float64 precision until trailing-window recovery.
Instantaneous fields compact directly to their Float32 output. A rolling cache
retains only the three raw fields needed by the next companion window; returned
arrays and receipts cannot mutate that cache.

`session.stats` reports transport/cache counts, per-packing decode and compaction
measurements, raw-companion hits and peak reserved working bytes. Load timings
can overlap other work and must not be added as exclusive phase durations. The
reservation is conservative admission accounting, not an RSS measurement; the
build budget also includes completed frame arrays, packing, rendering and runtime
headroom. Measure whole-job RSS separately. Admission and diagnostic proof use
the same [load/inspect path](load.ts), and section hashes consume ordered buffer
views without concatenating the sections.

To populate a new cache with all eight frames without rendering:

```sh
pnpm exec node --import tsx scripts/benchmark-acquisition.ts \
  --cycle 2026-11-01T12:00:00Z --cache-dir output/fresh-input-cache \
  --online --hours all --output output/input-receipt.json
```

Choose an available cycle; omit `--online` for a strictly cache-only replay.
The evidence tool's `--help` documents experimental concurrency overrides.
[Operations](../../../../docs/operations.md) owns build
execution and [science](../../../../docs/science.md) owns interpretation.
