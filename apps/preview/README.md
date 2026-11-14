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
and selected time. Auto and 50% lift opacity are the defaults; explicit URL
selections take precedence. The URL preserves the requested time as you pan.

Wind defaults to white trails when the selected build publishes numeric wind.
The height rail selects Surface, AGL stops and Top of lift. Its menu selects
barbs or hybrid flow, visibility and pause. The km/mi control switches all display
units; the lift key switches AGL/MSL and opacity. Day arrows retain the local
time where the published frames allow it.

Set `VITE_GOOGLE_MAPS_API_KEY` for Google Terrain through the official Map Tiles
API. Without a key, the map uses OpenStreetMap. The location control requests
one position when tapped.

The timeline shows the selected time, displayed time and image quality separately.
Prepared viewport overviews respond during scrubbing; fine tiles replace a complete overview.

The startup bundle includes MapLibre and triggers Vite’s large-chunk warning.
The Windgram loads in a separate chunk on the first map click.
[Build checks](vite.config.ts) bound startup and lazy JavaScript transfer and
reject server modules in the browser output.
The [performance report](../../docs/preview-performance.md) records bundle
measurements and the separate MapLibre worker boundary.

Click the map to open the Windgram. Sampled AGL and MSL lift appear while the
chart loads and in its selected hour readout. Open forecast settings to change
units or horizon, or open Chart details for height inspection and the legend.
A failed profile page leaves available lift visible.

Chart times within the map horizon select raster frames. Later point times keep
the map frame and show both UTC times. The scalar chart covers builds that
publish no native profiles. Builds without a map prefix offer a 24-hour point view.

## Source layout

- [src/main.ts](src/main.ts): map, forecast and point-card lifecycle.
- [src/basemap.ts](src/basemap.ts): Google Terrain sessions and OpenStreetMap fallback.
- [src/wind-overlay.ts](src/wind-overlay.ts): numeric wind loading, trails and barbs.
- [src/wind-controls.ts](src/wind-controls.ts): height and display controls.
- [src/compact-timeline.ts](src/compact-timeline.ts): frame and local-day selection.
- [src/url-state.ts](src/url-state.ts) reads and writes shared map URLs.
- [src/raster-overlay.ts](src/raster-overlay.ts): raster replacement and prefetch.
- [src/raster-overview.ts](src/raster-overview.ts): bounded decoded viewport images across forecast times.
- [index.html](index.html): application shell.
- [package.json](package.json): Vite scripts.

Shared client helpers live in [`@av/client`](../../packages/client/README.md).
See [the data guide](../../docs/data.md) for units and coverage.

## Layer benchmark

[Measured results](../../docs/preview-performance.md) compare viewport overviews with detailed tiles.

Compare the baseline and current preview in isolated Chromium sessions:

```sh
pnpm exec playwright install chromium
pnpm bench:preview --baseline 2f34b65 --channel chrome --frames 40 --out output/preview-layer-bench.json
```

Use `--channel chrome` for installed Chrome and inspect the recorded WebGL renderer.
The [benchmark](../../scripts/preview-layer-bench.ts) loads each revision’s actual
preview UI and serves patterned lossless WebP over HTTP/2 with controlled latency.
Nine framebuffer probes verify time, layer and position, recording first-correct
and fully detailed views separately. Cold and warmed 40-frame sweeps dispatch
every 60 or 120 ms; settled steps include the point card.

Use `--scenario cold --delay-ms 250` or `500` to measure slower tile responses.
The JSON records source fingerprints, per-input latency, preparation and workload
bytes, retained heap, textures and native image pixels. Repeated pans and time
changes measure retention; adjacent PNGs show the final views. See the measured
results for accounting scope and the transparency smoke command.
