# Windy AV Layer

Thermal-lift and precipitation forecasts for Windy and standalone maps.

Windy AV Layer turns weather-model output into map tiles and numeric point
forecasts. It provides usable lift above sea level, usable lift above model
terrain, and precipitation rate. A batch job prepares each forecast; a small
read-only API serves the same immutable build to every client.

The GFS pipeline has completed a real local build and API validation. Remote
publication and actual Windy-host integration still need verification; regional
products are deferred. See [project status](docs/status.md) for the evidence and
remaining release work.

## Quick start

Use the Node and pnpm versions declared in [package.json](package.json), then
run from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm tools:pmtiles
pnpm build:sample --model gfs --out output
```

This downloads real GFS inputs and builds a forecast day. The command prints
the resulting manifest path. Continue with the [local quick start](docs/getting-started.md)
to serve that build, open the map, and sample a point. The guide also covers
toolchain setup and using an existing build.

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
- [Architecture](docs/architecture.md) — follow the data flow and find each package.
- [Operations](docs/operations.md) — publish, deploy, monitor, and recover a service.
- [Development](docs/development.md) — change the code and keep its contracts clear.
- [Project status](docs/status.md) and [roadmap](docs/roadmap.md) — what is verified and what comes next.

The running API provides its generated reference at `/docs` and `/openapi.json`.

## Development checks

Run these from the repository root before submitting a change:

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
git diff --check
```

These check the code, fixtures, client bundles, and Worker bundle. Live-data
and deployed-service verification are covered in the
[development guide](docs/development.md).

## Attribution and licensing

The project uses NOAA data, Natural Earth coverage geometry, PMTiles, and
selected helpers from related forecasting projects. Public distribution still
requires clarification of rights for adapted private-source code. Attribution,
license texts, and the unresolved rights status are recorded in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
