# Serving resource budgets

The API bounds concurrent requests, R2 range reads, cache memory, and response
allocations in [apps/api/src/resources.ts](../apps/api/src/resources.ts).
[Project status](status.md) records live deployments. Limits apply to the
combined work across all grids selected by a request.

## Cache and in-flight limits

- **Pointer cache:** 32 entries, 1 MiB max; 15 s positive TTL, 5 s unavailable
  TTL. A build-ID miss coalesces a pointer refresh throttled to 1 req/s.
- **Discovery response cache:** catalog, latest and retained-run lists share
  the remaining pointer freshness and live build deadlines. Browsers revalidate;
  the Cache API stores bounded bodies under the existing response pool.
- **Client tile transport:** preview and Windy share `createRasterTileProtocol`.
  It keeps 4 requests active, at most 2 of them prefetch, and queues 64. The
  compressed tile cache is 48 MiB including entry overhead. Build expiry drops
  that build's cache. Palette responses stay revalidatable. Build-specific tile,
  manifest, provenance, and TileJSON responses stay immutable until `expiresAt`.
- **Manifest cache:** 64 entries, 4 MiB max, bounded by `expiresAt`; 4
  concurrent cold loads. Successful static product validation follows manifest
  and product identity; retained-entry binding and expiry run on every request.
- **Coverage cache:** 16 entries, 24 MiB max; 2 concurrent cold loads. Verifies
  descriptor and mask SHA-256 digests. Sparse entries include decoded block masks
  and compact sample layouts. Tile requests load only descriptors and tile masks.
  Each caller joining a cold load occupies a `MaterializedReads` waiter slot.
  Verified descriptor, sparse and tile mask bytes also stay in the Cache
  API under their SHA-256. A new isolate reads those blobs before R2. The
  in-memory cache remains the hot path. Blob reads and background writes use the
  shared allocation pool; write permits last until Cache API settlement.
  Request-held sparse objects reserve shared allocation bytes until their last
  lease ends, including after cache eviction.
- **PMTiles directory cache:** 256 entries, 4 MiB max (96 B/entry, max 16,384
  entries/directory); 8 concurrent tile reads. Identical archive ranges share
  materialized bytes, with 8 active ranges, 128 waiters and the default queue
  and deadline limits in `MaterializedReads`. Cancelling one waiter preserves
  the read for remaining consumers.
- **Binary sample & provenance reads:** 8 concurrent loads; identical range
  reads coalesce and share materialized `Uint8Array` bytes. Up to 64 distinct
  reads wait FIFO and 96 callers may wait in total. Each V5 point request
  starts at most 4 numeric reads concurrently across scalar and profile
  ranges. The 15 s deadline includes queue time.
- **Memory & response pools:** 32 MiB shared stream/verification pool (provenance
  reserves from verified object length) and 16 MiB outgoing response pool (4×
  body size reserved until client and Cache API streams settle). Operations
  time out after 15 s.
  Requests exceeding any pool or concurrency limit return uncached HTTP 503.

Per-object byte caps: pointer 128 KiB, manifest 512 KiB, coverage descriptor
128 KiB, coverage tile bitset 512 KiB, provenance 4 MiB, PMTiles range 1 MiB,
combined sample ranges 256 KiB. Sparse coverage is admitted only when decoded
masks, indexes, tiles and metadata fit the 24 MiB cache entry bound and the
shared in-flight pool. Version-5
scalar/profile objects are at most 64 MiB; point requests read bounded ranges
from them. Build admission and assembly enforce aggregate numeric bytes through
[`BUILD_BUDGETS`](../apps/batch/src/capacity.ts).
JSON structural token caps: 16,384 for manifests, 8,192 for other metadata,
262,144 for provenance, max depth 32, max 256 keys/elements per container. Request URLs cap
at 16 KiB.

Publication compacts scalar hours into serving groups in
[serving-groups.ts](../apps/batch/src/serving-groups.ts). V5 `/sample` and
`/samples` can split cell spans into row spans or selected records to fit the
combined byte budget. `/profile` charges each scalar or profile group's
contiguous span from its first selected channel to its last for the nearest
covered native cell.

Profile responses cap JSON at 1 MiB. The point loader uses `maxProfileFrames`
to page the selected fields and native levels under the server's response
estimate. See [point-products.ts](../packages/contracts/src/point-products.ts).

## Memory envelope

For 20 concurrent requests, the conservative modeled Worker footprint is
**111 MiB**. The previous 96 MiB local test gate predates the larger coverage
cache; full Worker memory measurements for this configuration remain pending.

- 33 MiB caches (pointer, manifest, coverage, PMTiles directories)
- 32 MiB active stream and verification buffers
- 16 MiB outgoing response reservations
- 8 MiB transient parsed metadata and directory structures
- 22 MiB Worker runtime and stack headroom

## Runtime and load checks

`pnpm test:integration apps/api` includes a local `workerd` coalescing test verifying that 8
concurrent requests share a single R2 read and complete if the initiating client
disconnects.

Response headers `X-Av-R2-Reads`, `X-Av-R2-Bytes`, `X-Av-Cache-Hits`,
`X-Av-Coalesced` and `X-Av-Response-Cache` report storage and cache activity.
`Server-Timing` reports total Worker wall time, pinned manifest admission
(`admit`), and the sum of R2 get and body waits owned by the request (`r2`).
Parallel reads can overlap. The health probe records these spans when present.
Measure decode CPU locally because the deployed Worker clock advances on I/O.
Set `AV_REQUEST_METRICS=true` for structured route logs.

Sustained load tests run for 5 minutes per cache mode (`AV_RESPONSE_CACHE=on` vs
`off`) at 10 req/s (90% tiles, 4% samples, 6% metadata, max 20 concurrent,
3,000 total requests), recording p50/p95 latency, cache hit rates, and local
`Runtime.getHeapUsage` samples every 100 ms.
