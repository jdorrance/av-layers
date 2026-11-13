# Development

Run commands from the repository root. See [deployments](status.md) for live
applications and [architecture](architecture.md#workspace-map) for package layout.

## Setup

Use the pnpm version in [package.json](../package.json):

```sh
pnpm install
pnpm tools:pmtiles
```

pnpm installs the pinned Node runtime locally. `pnpm tools:pmtiles` installs
the PMTiles CLI in the current worktree's `.tools/` for archive tests. For
offline setup, run `pnpm install --offline` with a populated store and copy
`.tools/pmtiles` from a prepared worktree on the same machine. Use the version
pinned in [pmtiles.json](../apps/batch/pmtiles.json).

## Start the sample-data map

```sh
pnpm dev
```

Generates a small synthetic forecast under `output/offline-fixture`, seeds local
R2 state in `.wrangler/fixture-state`, and starts the local API (`http://127.0.0.1:8787`)
and MapLibre preview. Open `/docs` on the API port for interactive OpenAPI docs.
On the first frame at latitude `40`, longitude `-100`, `precip-rate` is
`2.75 mm/h`.

Use `pnpm dev --generate-only` to write fixture files without starting servers,
or `pnpm dev --seed-only` to seed `.wrangler/fixture-state` and exit.

## Build a real forecast

Build the configured GFS forecast with a pinned catalog and complete
[local terrain store](../apps/batch/src/terrain/README.md#import-a-dataset):

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs \
  --terrain-catalog-ref output/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
```

For ICON-EU:

```sh
pnpm capacity --model icon-eu
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
pnpm forecast --model icon-eu --out output --cache-dir .cache/icon-eu \
  --terrain-catalog-ref output/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
```

`capacity` reports configured whole-domain sparse storage and working-set
admission. `input:proof`
downloads and validates one frame. `--cycle YYYY-MM-DDTHH:00:00Z` selects a
configured UTC cycle; otherwise providers discover the latest complete run
automatically. See the [CLI reference](reference.md#batch-cli) for all flags.

To view a completed build locally:

```sh
pnpm sample-preview --manifest output/builds/MODEL/BUILD_ID/manifest.json
```

This validates the build, seeds local Wrangler storage, and starts the API and
preview server.

### WRF Zarr

Read a committed `av-wrf` store with an explicit UTC cycle. The source directory
contains `upstream/`; terrain uses the same pinned catalog as other forecasts.
The public `av-wrf` product uses the current pilot configuration. Its upstream
model ID, grid, coverage and forecast window live in [models.json](../packages/contracts/config/models.json).

```sh
pnpm input:proof --model av-wrf --cycle 2026-11-13T00:00:00Z \
  --source-store-dir ../av-wrf/output/forecast-20261113/store
pnpm forecast --model av-wrf --cycle 2026-11-13T00:00:00Z \
  --source-store-dir ../av-wrf/output/forecast-20261113/store --out output/wrf-preview \
  --terrain-catalog-ref output/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
pnpm sample-preview --manifest output/wrf-preview/builds/av-wrf/BUILD_ID/manifest.json
```

Preview opens on the configured extent and serves native weather profiles plus
terrain-derived lift. The [adapter](../apps/batch/src/wrf-zarr/README.md)
verifies producer receipts and preserves model-level pressures and Earth-relative
winds. Omit `--source-store-dir` to read private R2. WRF is event-driven;
scheduled `all` runs continue selecting scheduled models.

### Terrain refinement

Save the terrain import's catalog reference as `output/terrain-catalog-ref.json`.
The local store must contain the referenced catalog, pinned inventory snapshot
and DEM assets. Omit `--terrain-store-dir` to use R2 with the
[terrain credentials](../apps/batch/src/terrain/README.md#import-a-dataset).
The configured whole-domain lift grids require the catalog to pass validation
before weather acquisition starts.

## Tests and builds

```sh
pnpm test
pnpm test:integration
pnpm verify
```

`pnpm test` runs the unit project. `pnpm test:integration` runs tests that
start local workerd, package PMTiles, or build the Windy plugin. Either
command accepts a path filter. To run the optional retained DWD
probe check for ICON-EU, set `ICON_DWD_PROBE_DIR` as shown in the
[ICON adapter guide](../apps/batch/src/split-grib/README.md).

`pnpm verify` checks the PMTiles version before lint, typecheck, both test projects,
`docs:check`, and app builds. After changing API schemas, product configs, or
CLI flags, regenerate the reference docs:

```sh
pnpm docs:generate
pnpm docs:check
```

## Troubleshooting

- **Missing PMTiles binary:** complete [worktree setup](#setup).
- **Port in use:** pass `--port 8788` to `pnpm dev` or `pnpm sample-preview`.
- **Expired local build:** rerun `pnpm dev` or `pnpm forecast`.
- **Corrupt local state:** stop the servers and remove `output/offline-fixture`
  and `.wrangler/fixture-state`.
- **Regenerate coverage masks:** install `uv` and run `pnpm masks:build`.
