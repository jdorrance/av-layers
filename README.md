# Aviation Forecast Layers

Thermal-lift and precipitation forecast tiles and point-series API for any map or client.

This service turns weather-model output into map tiles and numeric point
forecasts. It provides usable lift above sea level, usable lift above model
terrain, and precipitation rate. A batch job prepares each forecast; a small
read-only API serves the same immutable build to any consumer (standalone maps,
web or mobile apps, flight-planning tools, or host plugins such as Windy).

The foundation implementation includes manifest v3, native-grid fixtures, bounded
build/serving resources and offline development. Final deployed qualification is
tracked explicitly; all new live models and products remain deferred. See [project status](docs/status.md) for the evidence and
remaining release work.

## Quick start

Use the Node and pnpm versions declared in [package.json](package.json), then
run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm tools:pmtiles
pnpm dev:fixture
```

This builds and serves a tiny, clearly marked synthetic forecast without NOAA
or basemap access. Open it using the [offline development guide](docs/local-development.md).
For real forecasts, use the [GFS quick start](docs/getting-started.md).

## Reading the forecast

The map shows estimates at weather-model resolution. Zooming in smooths the
display; it does not add local terrain or finer weather information. Coverage
is limited to the project's land and coastal mask, and the precipitation
palette is provisional.

Read [the data guide](docs/data.md) for units, coverage, time intervals, and the
difference between no usable lift and missing data. The
[scientific method](docs/science.md) explains how the estimates are derived.

## Documentation

- [Getting started](docs/getting-started.md) — build, serve, and inspect a local forecast.
- [Data guide](docs/data.md) — interpret layers, samples, coverage, and freshness.
- [Generated reference](docs/reference.md) — current CLI options, capabilities, units, status, budgets and OpenAPI.
- [Architecture](docs/architecture.md) — follow the data flow and find each package.
- [Operations](docs/operations.md) — publish, deploy, monitor, and recover a service.
- [Offline development](docs/local-development.md) — a tiny synthetic forecast with no weather downloads.
- [Extension recipes](docs/extensions.md) — the proof required before admitting a model, grid or quantity.
- [Serving budgets](docs/serving-budgets.md) — byte limits, load qualification and memory evidence.
- [Development](docs/development.md) — change the code and keep its contracts clear.
- [Foundation implementation plan](docs/foundation-plan.md) — complete the platform before adding models or forecast products.
- [Project status](docs/status.md) and [roadmap](docs/roadmap.md) — what is verified and what comes next.

The running API provides its generated reference at `/docs` and `/openapi.json`.

## Deploying

Releases run in GitHub Actions. After the one-time Cloudflare and GitHub
environment setup, run **Bootstrap Cloudflare resources**, then **Forecast
sample**, then **Deploy Worker and Pages**. Pushes to `main` thereafter verify
and redeploy automatically, and forecasts publish on a regular schedule. The exact
variables, secrets, token scopes, and order are in
[Operations](docs/operations.md#deploy-and-schedule).

## Development checks

Run these from the repository root before submitting a change:

```sh
pnpm verify
```

This runs lint, type checks, fixture tests, the actual local Worker test, documentation checks and bundle builds once each. CI uses the same command. `pnpm build` bundles artifacts; it does not repeat type checking. Live-data
and deployed-service verification are covered in the
[development guide](docs/development.md).

## Attribution and licensing

The project uses NOAA data, Natural Earth coverage geometry, PMTiles, and
first-party helpers from related forecasting projects. The project records
windgrams/skyjuice adaptations and preserves dependency and data attribution.
Provenance and applicable license texts are recorded in [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
