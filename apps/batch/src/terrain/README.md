# Terrain inputs

Imports Copernicus GLO-90 surface elevation tiles (metres relative to EGM2008)
into an immutable R2 catalog, reads bounded geographic windows, and prepares
reusable elevation arrays on target forecast grids.

## Import a dataset

Run the **Global terrain** workflow on `main` for `staging` or `production`, or
invoke the CLI steps directly:

```sh
pnpm terrain inventory --out output/terrain-inventory.json
pnpm terrain sync --inventory output/terrain-inventory.json --out output/terrain-sync.json
pnpm terrain finalize --inventory output/terrain-inventory.json --out output/terrain-catalog-ref.json
```

Set `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and
`R2_BUCKET` (or `TARGET_ENV=staging|production`), or pass `--store-dir PATH` for
local storage. `sync` accepts `--shard`, `--shards`, and `--concurrency` and
reuses verified upload receipts across retries. [repack.py](repack.py) losslessly
repacks each source tile into a 512×512-tiled Cloud-Optimized GeoTIFF via `uv`
([ingest.ts](ingest.ts)).

## Read and prepare a region

```sh
pnpm terrain inspect --catalog-ref output/terrain-catalog-ref.json \
  --bounds 43.99,40.49,44.01,40.51 --out output/terrain-read.json
pnpm terrain prepare --catalog-ref output/terrain-catalog-ref.json \
  --grid scripts/fixtures/terrain-grid.json --out output/terrain-prepared-ref.json
pnpm terrain stage --prepared-ref output/terrain-prepared-ref.json \
  --grid scripts/fixtures/terrain-grid.json --out output
```

`--bounds` takes `west,south,east,north` (with `west > east` crossing the
dateline). `prepare` bilinearly samples native GLO-90 elevations at target cell
centres and writes little-endian `Float32` elevations plus a 1-byte validity
mask for any [`Grid`](../../../../packages/contracts/src/geometry.ts).

## Use in forecasts

The `forecast-terrain` operation prepares or validates packed DEM values in R2
from the pinned global catalog. Its cache identity binds source data, fine grid,
coverage and preparation method. Progress reports expose preparation and reuse.
The [whole-domain producer](../whole-domain/prepare.ts) stages cached values in
sparse coverage offset order with coverage files in the frozen plan. Shards
validate their identities and load them before weather acquisition. Local
forecast builds prepare a missing cache on first use.
[Regional evaluation](../refinement/README.md) retains polygon-grid preparation.

Prepare a configured model locally and upload its verified arrays to R2:

```sh
pnpm terrain prepare-model --model icon-eu --catalog-ref output/terrain-catalog-ref.json \
  --source-cache-dir .cache/terrain-source/icon-eu --out output/terrain-icon-eu.json
```

Use `--model gfs` for GFS. Preparation retains up to 2 GiB of verified source
files per model and fetches up to four files concurrently. Each completed
65,536-cell window writes a verified checkpoint to R2. Retrying the command or
failed workflow resumes those windows. Completed arrays and their manifest
retain the existing terrain identity.

[Operations](../../../../docs/operations.md#terrain-data) configures the hosted
catalog pin; [development](../../../../docs/development.md#build-a-real-forecast)
covers local builds with `--terrain-catalog-ref PATH`.

Legacy native-grid builds accept `--terrain-ref PATH` and the hosted
`terrain-inputs` model map. Those references keep their own recipe identity and
must match the forecast product's grid.

```mermaid
flowchart LR
  source[Native GLO-90] --> ingest[Verify and repack once]
  ingest --> catalog[Immutable global catalog and COGs]
  catalog --> reader[Bounded native reader]
  reader --> prepare[forecast-terrain: prepare requested grid]
  prepare --> artifact[Reusable R2 elevation and validity arrays]
  artifact --> plan[Forecast plan: validate and stage cached arrays]
  plan --> shards[Local load once per shard]
```

## Source layout

- [contract.ts](contract.ts): schemas, digests, and bounds validation.
- [source.ts](source.ts), [ingest.ts](ingest.ts), [repack.py](repack.py): upstream inventory, resumable R2 import, and COG repacking.
- [reader.ts](reader.ts): bounded COG range reads, tile seam stitching, and block cache.
- [prepare.ts](prepare.ts), [sparse.ts](sparse.ts), [staging.ts](staging.ts): grid resampling, packed coverage-bound terrain, and local shard staging.
- [cli.ts](cli.ts) & [local-store.ts](local-store.ts): CLI entry point and filesystem storage backend.

Run tests:

```sh
pnpm test apps/batch/src/terrain
uv run --python 3.12 --with rasterio==1.4.3 --with numpy==2.2.6 \
  python apps/batch/src/terrain/test_repack.py
```
