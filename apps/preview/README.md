# Map preview

Standalone MapLibre GL viewer for forecast tiles and point time series.

Start both the local API and preview map with generated test data from the
repository root:

```sh
pnpm dev
```

To run, test, or build `@av/preview` against an existing API:

```sh
AV_API_BASE=http://127.0.0.1:8787 pnpm --filter @av/preview dev
pnpm test apps/preview
pnpm --filter @av/preview build
```

`AV_API_BASE` defaults to `http://localhost:8787`. Set
`VITE_OFFLINE_FIXTURE=true` when serving the synthetic fixture (`pnpm dev`).
Reload the page to pick up a newly published build (subject to the API's
15-second [pointer cache](../../docs/serving-budgets.md)).

Click the map for a diurnal lift chart and point summary. Chart hours and the
arrow keys select map frames from the cached series. Point units switch between
metres/m/s and feet/knots; missing terrain remains unknown.

## Source layout

- [src/main.ts](src/main.ts): Google terrain map, model and AGL/MSL controls, local/UTC time, and the point card.
- [index.html](index.html): application shell.
- [package.json](package.json): Vite scripts.

Shared client helpers live in [`@av/contracts/client`](../../packages/contracts/README.md).
See [the data guide](../../docs/data.md) for units and coverage.
