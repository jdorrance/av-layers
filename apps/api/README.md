# API

`@av/api` serves published forecasts from a private R2 bucket as JSON metadata,
bounded point samples and lossless WebP XYZ tiles. It reads immutable artifacts and checks
retained membership and expiry; it never acquires weather or runs the solver.

Run an empty local Worker from the repository root:

```sh
pnpm --filter @av/api dev
```

For useful forecast data, follow the [populated local preview](../../docs/getting-started.md).
The running Worker's [docs](http://127.0.0.1:8787/docs) and
[OpenAPI document](http://127.0.0.1:8787/openapi.json) own its HTTP contract.

Discover a build with `/v1/models/gfs/latest?expand=manifest`, then pin its
`manifest.buildId` for tile and sample requests. For example:

```sh
AV_BUILD_ID='BUILD_ID_FROM_LATEST'
curl "http://127.0.0.1:8787/v1/models/gfs/runs/$AV_BUILD_ID/sample?lat=32.9&lon=-117.25&frame=f003"
```

When source receipts are available, `source.provenanceUrl` links to the complete
provenance for that build. The API verifies external receipt hashes and applies
the same retained-build and expiry checks used for forecasts. Older builds with
inline receipts remain readable through that link.

Outside coverage is a normal sample status or transparent tile. Unknown or
expired builds return 404; a missing tile inside coverage is an uncached 503.
Build admission happens before either blank tiles or cached responses are served.

[src/index.ts](src/index.ts) owns routing, admission and response caching;
[src/pmtiles.ts](src/pmtiles.ts) adapts the existing archive reader.
[wrangler.jsonc](wrangler.jsonc) owns deployment bindings and limits.
See [operations](../../docs/operations.md) for deployment and recovery, and
[data](../../docs/data.md) for units, statuses and freshness.
