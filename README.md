# Aviation Forecast Layers

Maps and point forecasts for usable lift above sea level, usable lift above model
terrain, and precipitation rate. A batch job builds the forecast files; an API
serves them to a standalone map and a Windy plugin.

This project is in alpha. NOAA GFS is the only supported weather model. More
models, WRF, and additional forecast products are future work. These are estimates
at model resolution; zooming in does not add local weather or terrain detail.

## Quick start

Use the pnpm version in [package.json](package.json). Run from the repository root:

```sh
pnpm install
pnpm tools:pmtiles
pnpm dev
```

This starts both the API and map with generated test data. Open the URL printed
by the development server. The test map needs no NOAA downloads or Cloudflare
account. For a real forecast, follow [the GFS setup guide](docs/development.md#build-a-real-gfs-forecast).

## Development checks

Use `pnpm test` while working, and `pnpm verify` before submitting a change.
`pnpm build` bundles the apps without deploying them.

The project uses the Node version declared in `package.json`; pnpm installs it
locally. [Local development](docs/development.md) covers the test data and
server options.

## Project layout

- [apps/batch](apps/batch/README.md): downloads GFS data and builds forecast files.
- [apps/api](apps/api/README.md): serves forecast details, tiles, and point results.
- [apps/preview](apps/preview/README.md): standalone map.
- [apps/windy-plugin](apps/windy-plugin/README.md): Windy integration.
- [packages/contracts](packages/contracts/README.md): shared types and API helpers.
- [packages/forecast](packages/forecast/README.md): calculations and grid sampling.

## More information

- [Data guide](docs/data.md): units, coverage, forecast times, and missing values.
- [Science](docs/science.md): how lift and precipitation are calculated.
- [Development](docs/development.md): working on the code.
- [Operations](docs/operations.md): publishing forecasts and deploying the apps.

Source data and third-party license notices are listed in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
