# Map preview

A standalone MapLibre map for viewing forecast layers and sampling a point over
time. It uses the same API as the Windy plugin.

Use `pnpm dev` from the repository root to start the API and map with generated
test data. See [setup](../../README.md) for the first install.

To run this app against an existing API, or test and build it separately:

```sh
AV_API_BASE=http://127.0.0.1:8787 pnpm --filter @av/preview dev
pnpm test apps/preview
pnpm --filter @av/preview build
```

For the separate app command, the API must already have forecast data. Open the
URL Vite prints, choose a layer and time, then click the map and select
**Sample clicked point**.

The map checks for newly published forecasts when it becomes visible or focused,
and once a minute while visible. **Refresh latest forecast** checks on demand. A new
build updates the layer and hour lists together, keeps the selected layer and
nearest valid time, and clears point results from the previous build. It does not
move the map. Each forecast is read from the API; publishing data does not require
a Pages deployment. The API's [latest-pointer cache](../../docs/serving-budgets.md)
can delay discovery by up to 15 seconds.

`AV_API_BASE` defaults to `http://localhost:8787` and is also used when building.
Set `VITE_OFFLINE_FIXTURE=true` when using generated test data; this shows a test
label and removes external basemap requests. See [local development](../../docs/development.md).

Useful files:

- [src/main.ts](src/main.ts): map and panel behavior.
- [index.html](index.html): page layout.
- [package.json](package.json): Vite commands.

Shared API requests and display helpers live in
[contracts](../../packages/contracts/README.md). See [the data guide](../../docs/data.md)
for units, coverage, and forecast times.
