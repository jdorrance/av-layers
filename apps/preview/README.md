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

Choose **Auto** to use the finest available forecast that covers the map center
and selected time. The URL preserves Auto and the requested time as you pan.

The startup bundle includes MapLibre and triggers Vite’s large-chunk warning.
The Windgram loads in a separate chunk on the first map click.
[Build checks](vite.config.ts) bound startup and lazy JavaScript transfer and
reject server modules in the browser output.
On Node 22.23.4, the production build measured 348.2 kB gzip for the entry
and 29.2 kB for the Windgram. The separate MapLibre worker measured 150.6 kB.

Click the map to open the Windgram. Sampled AGL and MSL lift appear while the
chart loads and in its selected hour readout. Open forecast settings to change
units or horizon, or open Chart details for height inspection and the legend.
A failed profile page leaves available lift visible.

Chart times within the map horizon select raster frames. Later point times keep
the map frame and show both UTC times. The scalar chart covers builds that
publish no native profiles. Builds without a map prefix offer a 24-hour point view.

## Source layout

- [src/main.ts](src/main.ts): OpenStreetMap basemap, model and AGL/MSL controls, forecast clock, and point card.
- [src/url-state.ts](src/url-state.ts) reads and writes shared map URLs.
- [src/raster-overlay.ts](src/raster-overlay.ts): raster replacement and prefetch.
- [index.html](index.html): application shell.
- [package.json](package.json): Vite scripts.

Shared client helpers live in [`@av/client`](../../packages/client/README.md).
See [the data guide](../../docs/data.md) for units and coverage.

## Layer benchmark

[Measured results](../../docs/preview-performance.md) record the desktop baseline.

Compare the baseline and current raster overlay in an isolated Chromium session:

```sh
pnpm exec playwright install chromium
pnpm bench:preview --baseline origin/main --out output/preview-layer-bench.json
```

Use `--channel chrome` for installed Chrome and inspect the recorded WebGL renderer.
The [benchmark](../../scripts/preview-layer-bench.ts) serves patterned lossless WebP
with controlled tile latency. It records automatic time stepping, layer toggles,
explicit preparation, rapid selection and panning. Each sample waits for a render
after commit and checks five framebuffer positions against the target layer/time.
The JSON includes source fingerprints, per-sample latency, request counts and
browser heap observations; adjacent PNGs show the final views. GPU allocations
and production API latency require separate measurements.
