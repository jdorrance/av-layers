# API

Cloudflare Worker serving forecast catalogs, manifests, WebP map tiles, and
point samples from R2.

Start the local API and preview map with synthetic data after
[root setup](../../README.md#quick-start):

```sh
pnpm dev
```

The API listens on `http://127.0.0.1:8787` (`/docs` for Swagger UI,
`/openapi.json` for the OpenAPI 3.1 spec). To serve a real forecast locally, see
[development](../../docs/development.md#build-a-real-forecast).

Worker-only commands:

```sh
pnpm --filter @av/api dev
pnpm test apps/api
pnpm test:integration apps/api
pnpm --filter @av/api build
```

## Request flow

1. `GET /v1/catalog`: list registered models and their availability.
2. `GET /v1/models/:model/latest?expand=manifest`: fetch the current `buildId`,
   manifest, and tile URL templates.
3. Pin `buildId` for subsequent `GET /tiles/:model/:buildId/:layer/:frame/:z/:x/:y.webp`
   and `GET /v1/models/:model/runs/:buildId/sample` requests.

`/samples?points=lat,lon;lat,lon` batches coordinates in request order.
`/profile?lat=...&lon=...` returns scalars, vertical levels, and derived
diagnostics for the native grid cell identified by `cell`. `frame` selects
times and `layers` selects returned scalar channels while `derived` retains the
cell's complete soaring diagnostics. See [sampling and profiles](../../docs/data.md#time-and-retention).
Point routes default to the first frame. For complete timelines, page the
frames or use `frame=all` with a layer subset that fits the value budget.
See the [OpenAPI spec](../../docs/reference/openapi.json) for limits and schemas.

`/provenance` serves the run receipt or frame index; `?frame=f001` selects a
verified source receipt from an indexed run.

Latest and retained-run freshness describe the rendered map prefix. Catalog,
latest and retained-run lists use short edge caching within the
[pointer freshness budget](../../docs/serving-budgets.md); browsers revalidate.
Build-specific responses cache through their expiry bound. Health and error
responses use `no-store`.

Workers Cache serves successful tile responses before the Worker executes.
Tile misses validate the build and read its archive directly. Only tiles opt
into this front cache; metadata and point routes keep their request checks.

Version-5 manifests bind each layer to its native or fine surface. The scalar
reader supports both v5 shard layouts. Profiles are available on builds that
publish them. See [data](../../docs/data.md) for units and status flags.

Set `AV_REQUEST_METRICS=true` to log requests with route, status, publication
identity and R2 counters. [Serving budgets](../../docs/serving-budgets.md)
defines the cache and read limits.

## Source layout

- [src/index.ts](src/index.ts): Hono OpenAPI routes and Worker entry point.
- [src/publication.ts](src/publication.ts): pointer, manifest, and provenance verification.
- [src/coverage.ts](src/coverage.ts): coverage descriptor and bitset cache.
- [src/pmtiles.ts](src/pmtiles.ts): PMTiles directory cache and R2 range reader.
- [src/sample.ts](src/sample.ts): block-packed point sample reader and bilinear sampler.
- [src/resources.ts](src/resources.ts): concurrency, memory pool, and cache limits.
- [wrangler.json](wrangler.json): Worker bindings and environment settings.

See [operations](../../docs/operations.md) and
[serving budgets](../../docs/serving-budgets.md).
