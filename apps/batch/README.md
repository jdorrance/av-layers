# Forecast builder

Downloads GFS or ICON-EU weather data and builds map tiles, point sample packs,
and a build manifest.

Run from the repository root:

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs \
  --terrain-catalog-ref output/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
```

Writes the completed build under `output/builds/gfs/` and prints the manifest
path. Pass `--model icon-eu` for regional ICON-EU lift and `--cycle` to select a
specific UTC run. See [development](../../docs/development.md#build-a-real-forecast)
to preview the build locally.

Configured GFS and ICON-EU builds require `--terrain-catalog-ref PATH` for
whole-domain lift surfaces. Use `--terrain-store-dir PATH` for a local terrain
store; otherwise terrain comes from R2. GFS precipitation retains its native
surface. See [terrain setup](../../docs/development.md#terrain-refinement).

Estimate build resources from the bundled sparse coverage, or verify a single
upstream frame:

```sh
pnpm capacity --model icon-eu
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
```

See the [CLI reference](../../docs/reference.md#batch-cli) for all options and
[operations](../../docs/operations.md) for publication, rollback, and cleanup.
Run batch tests with `pnpm test apps/batch`.

## Source layout

- [src/cli.ts](src/cli.ts) & [src/commands.ts](src/commands.ts): CLI entry point and flag definitions.
- [src/build.ts](src/build.ts): sequential build orchestration and manifest assembly.
- [src/frame-build.ts](src/frame-build.ts): frame acquisition, derivation, packing, and tile rendering.
- [src/parallel.ts](src/parallel.ts): build-plan creation, shard execution, and shard assembly.
- [src/provider.ts](src/provider.ts) & [src/providers.ts](src/providers.ts): provider interface and model registry lookup.
- [src/gfs](src/gfs/README.md): NOAA GFS adapter.
- [src/icon](src/icon/README.md): DWD ICON-EU adapter.
- [src/render.ts](src/render.ts): WebP map tile rendering and PMTiles packaging.
- [src/terrain](src/terrain/README.md): Copernicus GLO-90 DEM import, window reader, and grid preparation.
- [src/whole-domain](src/whole-domain/prepare.ts): sparse coverage, packed terrain columns, bounded sample shards and frozen whole-domain inputs.
- [src/refinement](src/refinement/README.md): regional polygon grids and legacy refinement evaluation.
- [pmtiles.json](pmtiles.json): pinned `pmtiles` binary version and SHA-256 digests.

## Parallel builds

The [forecast workflow](../../.github/workflows/forecast.yml) accepts `all`,
`gfs`, or `icon-eu` and calls the reusable
[model workflow](../../.github/workflows/forecast-model.yml) per model.
`forecast-terrain` prepares or validates each model's reusable terrain cache in
R2. Planning then resolves the cycle and daylight-filtered hours, loads cached
terrain, and freezes coverage, terrain and recipe identities in the plan. Up to eight
`forecast-shard` workers stage verified terrain from R2 and upload validated
archives and frame-group sample shards directly. Each acquired native frame
supplies its native layers and packed fine lift fields. Assembly verifies the
complete receipt partition before publication. Workflow artifacts retain the
plan, coverage and receipts; full payload retention is opt-in.
Local forecast builds prepare terrain on first use and reuse it thereafter.

```mermaid
flowchart TB
  selection["Select one model or all registered models"]
  selection --> gfsTerrain["GFS: prepare or validate terrain cache"]
  selection --> iconTerrain["ICON-EU: prepare or validate terrain cache"]
  gfsTerrain --> gfs["GFS: resolve cycle and hours"]
  iconTerrain --> icon["ICON-EU: resolve cycle and daylight hours"]
  gfs --> gfsBatches["Parallel GFS hour batches"]
  icon --> iconBatches["Parallel ICON-EU hour batches"]
  gfsBatches --> gfsPublish["Assemble, validate, and publish GFS"]
  iconBatches --> iconPublish["Assemble, validate, and publish ICON-EU"]
  gfsPublish --> api["Verify each model's new build through the API"]
  iconPublish --> api
  api --> pages["Pages reads each published manifest and hour list"]
```

Concurrency locks are scoped per environment and model (`forecast-<env>-<model>`),
and artifacts are namespaced by model, run ID, and run attempt. See
[capacity.ts](src/capacity.ts) and [parallel.ts](src/parallel.ts) for resource
limits.
