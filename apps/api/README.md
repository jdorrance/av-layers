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
pnpm --filter @av/api build
```

## Request flow

1. `GET /v1/catalog`: list registered models and their availability.
2. `GET /v1/models/:model/latest?expand=manifest`: fetch the current `buildId`,
   manifest, and tile URL templates.
3. Pin `buildId` for subsequent `GET /tiles/:model/:buildId/:layer/:frame/:z/:x/:y.webp`
   and `GET /v1/models/:model/runs/:buildId/sample` requests.

See the [OpenAPI spec](../../docs/reference/openapi.json) for parameters and
[the data guide](../../docs/data.md) for units and status flags.

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
