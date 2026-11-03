# API

A Cloudflare Worker that serves forecast details, map tiles, and point forecasts
from completed builds in R2 storage.

After [root setup](../../README.md#quick-start), start the API and map with
generated test data:

```sh
pnpm dev
```

The API normally runs at `http://127.0.0.1:8787`. Open `/docs` to try requests or
read `/openapi.json` for the generated schema. To serve a real forecast locally,
follow [development](../../docs/development.md#build-a-real-forecast).

For work on the Worker alone, run these commands from the repository root:

```sh
pnpm --filter @av/api dev
pnpm test apps/api
pnpm --filter @av/api build
```

The standalone development server starts with empty local storage. `test` uses
local fixtures, and `build` bundles the Worker without deploying it.

## Request a forecast

Start with `/v1/catalog` to find available models, then request
`/v1/models/MODEL/latest?expand=manifest`. The response includes the build's
layers, times, and tile URL templates. Use its build ID for subsequent tile and
sample requests so a map displays one forecast run consistently. The
[API reference](../../docs/reference/openapi.json) describes the endpoints and
query options; [the data guide](../../docs/data.md) explains values and missing data.

## Source layout

- [src/index.ts](src/index.ts): routes and Worker entry point.
- [src/publication.ts](src/publication.ts): checks forecast files before serving them.
- [src/pmtiles.ts](src/pmtiles.ts): reads map tiles from archives.
- [src/sample.ts](src/sample.ts): reads and interpolates point forecasts.
- [src/resources.ts](src/resources.ts): request, memory, and storage-read limits.
- [wrangler.json](wrangler.json): local and deployed Worker settings.

See [operations](../../docs/operations.md) for deployment and
[serving budgets](../../docs/serving-budgets.md) for API limits.
