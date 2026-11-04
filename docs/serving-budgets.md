# Serving resource budgets

The API bounds concurrent requests, R2 range reads, cache memory, and response
allocations in [apps/api/src/resources.ts](../apps/api/src/resources.ts).
[Whole-domain measurements](whole-domain-refinement-progress.md) record current
validation evidence; [project status](status.md) records live deployments. Limits
apply to the combined work across all grids selected by a request.

## Cache and in-flight limits

- **Pointer cache:** 32 entries, 1 MiB max; 15 s positive TTL, 5 s unavailable
  TTL. A build-ID miss coalesces a pointer refresh throttled to 1 req/s.
- **Manifest cache:** 64 entries, 4 MiB max, bounded by `expiresAt`; 4
  concurrent cold loads.
- **Coverage cache:** 16 entries, 24 MiB max; 2 concurrent cold loads. Verifies
  descriptor and mask SHA-256 digests. Sparse entries include decoded block masks
  and compact sample layouts. Tile requests load only descriptors and tile masks.
  Request-held sparse objects reserve shared allocation bytes until their last
  lease ends, including after cache eviction.
- **PMTiles directory cache:** 256 entries, 4 MiB max (96 B/entry, max 16,384
  entries/directory); 4 concurrent tile reads.
- **Binary sample & provenance reads:** 8 concurrent loads; identical range
  reads coalesce and share materialized `Uint8Array` bytes. Up to 64 distinct
  reads wait FIFO and 96 callers may wait in total; each sample request starts
  at most 4 reads concurrently. The 15 s deadline includes queue time.
- **Memory & response pools:** 32 MiB shared stream/verification pool (12 MiB
  reserved per active provenance check) and 16 MiB outgoing response pool (4×
  body size reserved until client and Cache API streams settle). Operations
  time out after 15 s.
  Requests exceeding any pool or concurrency limit return uncached HTTP 503.

Per-object byte caps: pointer 128 KiB, manifest 512 KiB, coverage descriptor
128 KiB, legacy coverage bitset 512 KiB, provenance 4 MiB, PMTiles range 1 MiB,
combined sample ranges 256 KiB. Sparse coverage is admitted only when decoded
masks, indexes, tiles and metadata fit the 24 MiB cache entry bound and the
shared in-flight pool. Version-5
numeric objects are at most 64 MiB; point requests read bounded ranges from them.
JSON structural token caps: 8,192 for metadata, 262,144 for
provenance, max depth 32, max 256 keys/elements per container. Request URLs cap
at 16 KiB.

Point requests group layers by surface and frame group. GFS precipitation and
fine lift use separate ranges within the combined sample budget. Retained
regional patches load their coverage lazily.

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

`pnpm test` includes a local `workerd` coalescing test verifying that 8
concurrent requests share a single R2 read and complete if the initiating client
disconnects.

Response headers `X-Av-R2-Reads`, `X-Av-R2-Bytes`, `X-Av-Cache-Hits`,
`X-Av-Coalesced`, `X-Av-Response-Cache`, and `Server-Timing: worker` report
per-request storage and cache activity. Set `AV_REQUEST_METRICS=true` for
structured route logs.

Sustained load tests run for 5 minutes per cache mode (`AV_RESPONSE_CACHE=on` vs
`off`) at 10 req/s (90% tiles, 4% samples, 6% metadata, max 20 concurrent,
3,000 total requests), recording p50/p95 latency, cache hit rates, and local
`Runtime.getHeapUsage` samples every 100 ms.
