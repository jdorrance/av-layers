# Aviation Forecast Layers

Maps and point forecasts for usable lift above sea level, usable lift above
ground, and precipitation rate. A batch job builds the forecast files; an API
serves them to a standalone map and a Windy plugin.

The builder supports NOAA GFS and regional DWD ICON-EU. The forecast workflow
runs configured models in parallel; scheduled runs select them from
[model settings](packages/contracts/config/models.json). Whole-domain
terrain columns derive MSL and AGL lift; see [science](docs/science.md#terrain-columns).
Coverage excludes Africa, Russia, China, Antarctica and Greenland. See
[deployments](docs/status.md) for live applications and runs.

## Quick start

Use the pnpm version in [package.json](package.json). Run from the repository root:

```sh
pnpm install
pnpm tools:pmtiles
pnpm dev
```

This starts the local API and map with generated test data. Open the URL printed
by the development server. To build a real forecast, follow
[the forecast setup guide](docs/development.md#build-a-real-forecast).
The [terrain example](docs/development.md#terrain-refinement) uses
`--terrain-catalog-ref` and `--terrain-store-dir` for a local DEM store.

## Development checks

Run `pnpm test` while working and `pnpm verify` before submitting a change.
`pnpm build` bundles the apps locally.

pnpm installs the Node version declared in `package.json`.
[Local development](docs/development.md) covers test data and server options.

## Project layout

- [apps/batch](apps/batch/README.md): adapts weather sources and builds forecast files.
- [apps/api](apps/api/README.md): serves forecast manifests, tiles, and point samples.
- [apps/preview](apps/preview/README.md): standalone map.
- [apps/windy-plugin](apps/windy-plugin/README.md): Windy integration.
- [packages/contracts](packages/contracts/README.md): shared types and API helpers.
- [packages/forecast](packages/forecast/README.md): frame derivation, grid sampling, and sample-pack layout.
- [packages/solar](packages/solar/README.md): solar position, sunrise/sunset, and grid daylight checks.
- [packages/thermodynamics](packages/thermodynamics/README.md): dry-air thermodynamics and parcel equations.
- [packages/soaring](packages/soaring/README.md): thermal lift depth and updraft calculations.

## More information

- [Data guide](docs/data.md): units, coverage, forecast times, and missing values.
- [Science](docs/science.md): how lift and precipitation are calculated.
- [Development](docs/development.md): working on the code.
- [Operations](docs/operations.md): publishing forecasts and deploying the apps.
- [Deployments](docs/status.md): live applications and build history.

Source data and third-party license notices are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
