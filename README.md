# Aviation Forecast Layers

Maps, native weather samples and full atmospheric profiles for GFS, ICON-EU,
RRFS and av-wrf. A batch job builds immutable forecast files; an API serves
them to map clients and Windgrams.

The forecast workflow runs the [configured models](packages/contracts/config/models.json)
in parallel; their source profiles select NOAA, DWD or av-wrf inputs. Whole-domain
terrain columns derive MSL and AGL lift; see [science](docs/science.md#terrain-columns).
Coverage excludes Africa, Russia, China, Antarctica and Greenland. See
[deployments](docs/status.md) for live applications and runs.

## Quick start

Use the pnpm version in [package.json](package.json). Run from the repository root:

```sh
pnpm install
pnpm tools:pmtiles
pnpm tools:eccodes
pnpm dev
```

This starts the local API and map with generated test data. Open the URL printed
by the development server. To build a real forecast, follow
[the forecast setup guide](docs/development.md#build-a-real-forecast).
The [terrain example](docs/development.md#terrain-refinement) uses
`--terrain-catalog-ref` and `--terrain-store-dir` for a local DEM store.

## Development checks

Complete [setup](docs/development.md#setup) in each new worktree.
Run `pnpm test` while working. `pnpm test:integration` exercises local workerd,
PMTiles, and the Windy bundle. Run `pnpm verify` for both suites and app builds.
`pnpm unused` checks files, dependencies and internal exports with [Knip](knip.jsonc).
Its production pass also checks module reachability without test imports.

[Local development](docs/development.md) covers test data and server options.

## Project layout

- [apps/batch](apps/batch/README.md): adapts weather sources and builds forecast files.
- [apps/api](apps/api/README.md): serves forecast manifests, tiles, and point samples.
- [apps/preview](apps/preview/README.md): standalone map.
- [apps/windy-plugin](apps/windy-plugin/README.md): Windy integration.
- [packages/contracts](packages/contracts/README.md): wire schemas and shared forecast definitions.
- [packages/client](packages/client/README.md): pinned API requests and map transport.
- [packages/forecast](packages/forecast/README.md): frame derivation, grid sampling, and sample-pack layout.
- [packages/solar](packages/solar/README.md): solar position, sunrise/sunset, and grid daylight checks.
- [packages/thermodynamics](packages/thermodynamics/README.md): dry-air thermodynamics and parcel equations.
- [packages/soaring](packages/soaring/README.md): thermal lift depth and updraft calculations.
- [packages/windgram](packages/windgram/README.md): point windgram chart, scene, and height inspector.

## More information

- [Data guide](docs/data.md): units, coverage, forecast times, and missing values.
- [Science](docs/science.md): how lift and precipitation are calculated.
- [Development](docs/development.md): working on the code.
- [Operations](docs/operations.md): publishing forecasts and deploying the apps.
- [Deployments](docs/status.md): live applications and build history.

Source data and third-party license notices are in
[THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt).
