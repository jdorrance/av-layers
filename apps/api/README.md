# API

A Cloudflare Worker that serves forecast details, map tiles, and point forecasts
from R2 storage. It serves existing builds; it does not download weather data or
run forecast calculations. GFS is the only supported model.

Run from the repository root after `pnpm install`:

```sh
pnpm --filter @av/api dev
pnpm test apps/api
pnpm --filter @av/api build
```

The development server starts with empty local storage. Follow the
[root setup](../../README.md) for a local map with generated test data.
`build` bundles the Worker without deploying it.

The running API exposes `/docs` and `/openapi.json`. Start with `/v1/catalog`,
then `/v1/models/gfs/latest?expand=manifest`. Use that build's ID for subsequent
tile and sample requests so a map does not mix forecasts from different runs.

Useful files:

- [src/index.ts](src/index.ts): routes and Worker entry point.
- [src/publication.ts](src/publication.ts): checks forecast files before serving them.
- [src/pmtiles.ts](src/pmtiles.ts): reads map tiles from archives.
- [wrangler.json](wrangler.json): local and deployed Worker settings.

See [the data guide](../../docs/data.md) for values and missing-data rules, and
[operations](../../docs/operations.md) for deployment.
