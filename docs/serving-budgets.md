# Serving resource budgets

The API bounds concurrent requests, R2 range reads, cache memory, and response
allocations in [apps/api/src/resources.ts](../apps/api/src/resources.ts).
[Project status](status.md) records live deployments. Limits apply to the
combined work across all grids selected by a request.

## Cache and in-flight limits

- **Tile front cache:** Workers Cache shares immutable tile responses through
  its tiers and skips Worker execution on hits. TTL follows the build expiry
  with mandatory revalidation; misses validate and read the tile directly.
  Cache entries are isolated by deployment version. Other routes opt out.
  Cloudflare still consults its cache tiers for those uncached routes because
  the cache is configured per Worker entrypoint. Compare point and discovery
  latency during rollout; the tile path uses the public entrypoint directly.
- **Pointer cache:** 32 entries, 1 MiB max; 15 s positive TTL, 5 s unavailable
  TTL. Validated pointer bytes also use the Cache API with the original absolute
  deadline. A build-ID miss bypasses that shared entry and coalesces a pointer
  refresh throttled to 1 req/s.
- **Discovery response cache:** catalog, latest and retained-run lists share
  the remaining pointer freshness and live build deadlines. Browsers revalidate;
  the Cache API stores bounded bodies under the existing response pool.
- **Client tile transport:** preview and Windy share the
  [raster scheduler](../packages/client/src/client-raster.ts).
  It keeps 16 requests active and queues 64. Background work starts while fewer
  than 2 background reads are active; admitted reads finish after demotion. The
  compressed tile cache is 48 MiB including entry overhead. Preview retains up to
  four source handles using [viewport memory admission](../apps/preview/src/raster-budget.ts),
  with 16 offscreen tiles per source. The 96 MiB admission estimate charges visible
  and cached tiles at twice RGBA storage; large viewports shrink the prepared window.
  The displayed/replacement pair can exceed that estimate when required for a switch.
  With viewport overviews, one transport handle loads up to two coarse tiles at once.
  Up to 40 decoded 256² images share a 24 MiB reservation within the 96 MiB estimate;
  one image source uploads the selected overview. Fine-source admission can shrink to one.
  Overview retention stops when one fine source and that reservation cannot fit.
  A complete overview remains visible if detailed tiles fail. Time changes with an
  admitted overview window defer cold detail for 100 ms; prepared detail switches immediately.
  The overview queue replaces speculative high-resolution byte prefetch and prepares
  the selected layer before additional fine sources. Viewport, layer, build and expiry
  changes release decoded overviews. Unsupported browsers retain the raster-only path.
  Speculative overview preparation stops after 1 MiB of returned compressed tile bytes
  per viewport context, including cache reuse. An in-flight pair may finish; explicit
  time selections remain eligible. The timeline reports partial readiness when limited.
  MapLibre's texture pool and browser allocations are separate; the
  [input benchmark](preview-performance.md) records retained texture storage.
  Prepared-source loading shares the two-request prefetch limit. Cold selections
  drop unfinished background sources to release MapLibre's upstream image queue.
  Build expiry drops
  that build's cache. Palette responses stay revalidatable. Build-specific tile,
  manifest, provenance, and TileJSON responses stay immutable until `expiresAt`.
- **Manifest cache:** 64 entries, 4 MiB max, bounded by `expiresAt`; 4
  concurrent cold loads. Validated manifest bytes also use the Cache API through
  build expiry. Shared storage entries are scoped to the API origin; each read
  verifies its body digest and each manifest rechecks retained/product binding.
  Successful static product validation follows manifest
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
  entries/directory); 8 concurrent tile reads. Header/root and leaf range bytes
  also use the Cache API, keyed by archive SHA-256, range and ETag through build
  expiry. Tile payloads use the response cache. Identical archive ranges share
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
For front-cached tiles, these headers and `Server-Timing` describe the fill.
Use `Cf-Cache-Status` and `Age` to identify reuse; the health probe omits fill
counters on reused tiles. Deployment verifies a front-cache hit for each model.
`Server-Timing` reports total Worker wall time, pinned manifest admission
(`admit`), and elapsed time spent waiting on R2 reads owned by the request
(`r2`). Overlapping waits count once. The health probe records these spans.
Measure decode CPU locally because the deployed Worker clock advances on I/O.
Set `AV_REQUEST_METRICS=true` for structured route logs.
`AV_RESPONSE_CACHE=off` disables response, pointer, manifest and archive-range
Cache API reuse; isolate-local and digest-addressed coverage caches remain enabled.

Sustained load tests run for 5 minutes per cache mode (`AV_RESPONSE_CACHE=on` vs
`off`) at 10 req/s (90% tiles, 4% samples, 6% metadata, max 20 concurrent,
3,000 total requests), recording p50/p95 latency, cache hit rates, and local
`Runtime.getHeapUsage` samples every 100 ms.
