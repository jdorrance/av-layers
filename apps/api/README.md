# API

`@av/api` serves immutable v3 forecasts from private R2 as metadata, bounded point samples and lossless WebP XYZ tiles. It checks retained membership, expiry, recipe/product identity, artifact layout and coverage before serving a response. It never acquires weather or runs the solver.

From the repository root, `pnpm --filter @av/api dev` starts an empty local Worker. For useful local data, use the [offline synthetic preview](../../docs/getting-started.md). The running Worker's [docs](http://127.0.0.1:8787/docs) and [OpenAPI document](http://127.0.0.1:8787/openapi.json) describe the HTTP contract.

Discover an admitted model with `/v1/catalog`; only GFS is admitted in production. Fetch `/v1/models/gfs/latest?expand=manifest`, then pin `manifest.buildId` for tile and sample requests. The manifest's descriptors own layer labels, units, vertical/time support, status semantics, palettes, attribution, bounds and sample-result limit. A selection can use any admitted frame/layer combination within that limit; eight frames and three layers are not an API assumption.

Every build requires a provenance sidecar. `source.provenanceUrl` links to its exact hash-verified bytes. No legacy inline receipt fallback remains. Coverage is resolved lazily from `coverage/{hash}/manifest.json` and three hash-verified bitsets, then cached by content identity. Grid, bounds, coverage ID/zoom and sample layout must agree with the manifest. The production Worker does not bundle the GFS coverage raster.

Outside coverage is a normal sample status or transparent tile. Unknown or expired builds return 404. Missing/corrupt publications, incomplete covered tiles and resource-budget failures return uncached 503. Producer and reader use the same metadata/provenance byte and JSON-structure limits, so publication rejects receipts that serving could not admit. The point rate limiter runs before storage reads. Identical reads share materialized values; R2 bodies and Response streams remain request-owned.

[src/index.ts](src/index.ts) owns routing and the Worker entrypoint; [publication.ts](src/publication.ts) owns publication admission and verified provenance; [http.ts](src/http.ts) owns HTTP guards, responses, cache branches and problem mapping; [coverage.ts](src/coverage.ts) resolves immutable coverage; [resources.ts](src/resources.ts) owns bounded reads and caches; [pmtiles.ts](src/pmtiles.ts) adapts the archive reader. [wrangler.jsonc](wrangler.jsonc) owns bindings. The separate test entrypoint can inject synthetic products; production has no runtime fixture switch.

[Serving budgets](../../docs/serving-budgets.md) defines object/cache/concurrency limits and qualification commands. `X-Av-R2-Reads`, `X-Av-R2-Bytes`, `X-Av-Cache-Hits`, `X-Av-Coalesced` and `X-Av-Response-Cache` report request costs; `Server-Timing` is elapsed time including I/O. `AV_REQUEST_METRICS=true` enables coordinate-free aggregate request logs. `AV_RESPONSE_CACHE=off` is a deployment-only staging qualification setting; default production behavior caches responses. Restore normal caching before final qualification.

See [operations](../../docs/operations.md) for deployment/recovery and [data](../../docs/data.md) for interpretation. Local fixtures and mocks do not replace deployed GFS or actual Windy-host acceptance.
