# Preview

`@av/preview` is the standalone MapLibre client for viewing a pinned forecast
build and requesting a point series from the API.

With the local API running, start Vite from the repository root:

```sh
VITE_API_BASE=http://localhost:8787 pnpm --filter @av/preview dev
```

`VITE_API_BASE` defaults to `http://localhost:8787`; set it when building for a
different API. See [getting started](../../docs/getting-started.md) for setup.

[main.ts](src/main.ts) owns map and UI state. [api.ts](src/api.ts) exposes
`ApiClient` and the pinned-build types. The API, time and tile helpers also serve
the Windy plugin; this app does not acquire or derive forecast data.

See [data](../../docs/data.md) for interpretation and
[development](../../docs/development.md) for checks and test scope.
