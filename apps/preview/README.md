# Preview

`@av/preview` is the standalone MapLibre client for viewing a pinned forecast
build and requesting a point series from the API.

With the local API running, start Vite from the repository root:

```sh
VITE_API_BASE=http://localhost:8787 pnpm --filter @av/preview dev
```

`VITE_API_BASE` defaults to `http://localhost:8787`; set it when building for a
different API. See [getting started](../../docs/getting-started.md) for setup.

[main.ts](src/main.ts) owns map and UI state. Shared API, time, tile and
presentation helpers live in [`@av/contracts/client`](../../packages/contracts/README.md)
for any consumer; this app does not acquire or derive forecast data.

See [data](../../docs/data.md) for interpretation and
[development](../../docs/development.md) for checks and test scope.

Layer options, legend bins, series headings/units, attribution and scientific diagnostics come from the pinned v3 manifest descriptors. The preview shares pure presentation models and bounded API requests with the plugin; its MapLibre lifecycle, BFCache handling and expiry teardown remain independent.

For a disconnected development fixture, start the fixture Worker described in getting started, then set `VITE_OFFLINE_FIXTURE=true` alongside `VITE_API_BASE`. The preview uses a neutral background with no external basemap requests and displays a synthetic-data warning. `VITE_MODEL` optionally selects an explicit fixture model; its default is `gfs`. Synthetic output is not a weather forecast or deployed-product proof.
