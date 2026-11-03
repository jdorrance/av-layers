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

Pass `--terrain-ref PATH` to `pnpm forecast` locally, or pass a JSON map of
model IDs to prepared terrain references via `terrain-inputs` in the Forecast
workflow. The `prepare` job stages the arrays into the build plan artifact so
each shard worker loads them from local disk before acquiring weather frames.

```mermaid
flowchart LR
  source[Native GLO-90] --> ingest[Verify and repack once]
  ingest --> catalog[Immutable global catalog and COGs]
  catalog --> reader[Bounded native reader]
  reader --> prepare[Prepare requested grid]
  prepare --> artifact[Reusable elevation and validity arrays]
  artifact --> plan[Existing build-plan artifact]
  plan --> shards[Local load once per shard]
```

## Source layout

- [contract.ts](contract.ts): schemas, digests, and bounds validation.
- [source.ts](source.ts), [ingest.ts](ingest.ts), [repack.py](repack.py): upstream inventory, resumable R2 import, and COG repacking.
- [reader.ts](reader.ts): bounded COG range reads, tile seam stitching, and block cache.
- [prepare.ts](prepare.ts) & [staging.ts](staging.ts): grid resampling and local shard staging.
- [cli.ts](cli.ts) & [local-store.ts](local-store.ts): CLI entry point and filesystem storage backend.

Run tests:

```sh
pnpm test apps/batch/src/terrain
uv run --python 3.12 --with rasterio==1.4.3 --with numpy==2.2.6 \
  python apps/batch/src/terrain/test_repack.py
```
