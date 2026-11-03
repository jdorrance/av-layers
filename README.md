# Aviation Forecast Layers

Maps and point forecasts for usable lift above sea level, usable lift above model
terrain, and precipitation rate. A batch job builds the forecast files; an API
serves them to a standalone map and a Windy plugin.

This project is in alpha. The builder supports NOAA GFS and regional DWD ICON-EU.
The forecast workflow supports either model or both in parallel; scheduled runs
select both. See [status](docs/status.md) for completed deployment validation.
Forecasts use model resolution; zooming in does not add local weather or terrain detail.

## Quick start

Use the pnpm version in [package.json](package.json). Run from the repository root:

```sh
pnpm install
pnpm tools:pmtiles
pnpm dev
```

This starts both the API and map with generated test data. Open the URL printed
by the development server. The test map needs no NOAA downloads or Cloudflare
account. For a real forecast, follow [the forecast setup guide](docs/development.md#build-a-real-forecast).

## Development checks

Use `pnpm test` while working, and `pnpm verify` before submitting a change.
`pnpm build` bundles the apps without deploying them.

The project uses the Node version declared in `package.json`; pnpm installs it
locally. [Local development](docs/development.md) covers the test data and
server options.

## Project layout

- [apps/batch](apps/batch/README.md): adapts weather sources and builds forecast files.
- [apps/api](apps/api/README.md): serves forecast details, tiles, and point results.
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
- [Project status](docs/status.md): release checks and remaining work.

Source data and third-party license notices are listed in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
