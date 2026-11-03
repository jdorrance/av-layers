# Terrain inputs

Store native Copernicus GLO-90 elevations globally, read bounded windows, and
prepare reusable elevations on a calculation's grid. This is a surface model
(including vegetation and structures), in metres relative to EGM2008. It stays
separate from weather-model orography and does not change lift physics.

## Import a dataset

Run the **Global terrain** workflow on `main` for staging or production; both
storage environments restrict access to that branch. The workflow
verifies the code, freezes the full source inventory, imports independent
batches, and publishes a catalog only after every expected object is verified.
Verified receipts let interrupted imports resume without repeating completed
downloads and packing. The `terrain-release-RUN_ID` artifact contains the
catalog reference and a bounded preparation proof.

Tile failures name the tile and the operation that failed. Rerun failed jobs to
reuse verified receipts; cancellation stops remaining work without publishing an
incomplete catalog. Interrupted R2 response bodies get at most three read attempts,
each with a 30-second body deadline. Partial bytes are discarded; byte-budget and
integrity failures stop the operation.

Equivalent commands:

```sh
pnpm terrain inventory --out output/terrain-inventory.json
pnpm terrain sync --inventory output/terrain-inventory.json --out output/terrain-sync.json
pnpm terrain finalize --inventory output/terrain-inventory.json --out output/terrain-catalog-ref.json
```

Set `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`R2_BUCKET`, or use `TARGET_ENV=staging|production` to select the checked-in
bucket. Add `--store-dir /path/to/store` to each command for local immutable
storage instead. Credentials never enter artifacts. `sync` accepts `--shard`,
`--shards` and `--concurrency`; changing batch count still reuses receipts.

The pinned Python helper losslessly repacks each source object as a COG with
512-pixel internal blocks. It verifies native Float32 bits, placement, validity,
metadata and existing overviews before upload. `uv` is required only during
ingestion; runtime pins and packing settings live in [ingest.ts](ingest.ts).

## Read and prepare a region

```sh
pnpm terrain inspect --catalog-ref output/terrain-catalog-ref.json \
  --bounds 43.99,40.49,44.01,40.51 --out output/terrain-read.json
pnpm terrain prepare --catalog-ref output/terrain-catalog-ref.json \
  --grid scripts/fixtures/terrain-grid.json --out output/terrain-prepared-ref.json
pnpm terrain stage --prepared-ref output/terrain-prepared-ref.json \
  --grid scripts/fixtures/terrain-grid.json --out output
```

Bounds are west,south,east,north; west greater than east crosses the dateline.
`inspect` reports native window geometry, elevation ranges and I/O counters.
Native longitude spacing varies by latitude. The example target is a Lambert
grid with nominal 1,000 m projected spacing; the input JSON can specify any
admitted [Grid](../../../../packages/contracts/src/geometry.ts).

Preparation samples native elevation bilinearly at target cell centres. Missing
required contributors produce unavailable cells; averaged overviews are never
silently substituted. Results store little-endian Float32 elevations plus byte
validity masks. Invalid stored zeros are not sea-level measurements. Repeated
requests verify and reuse the prepared artifact without opening DEMs. Identity
includes original data, canonical target geometry and method version.

Cell count, downloaded bytes, decoded pixels and cache memory are bounded. Large
requests must be split into bounded preparations. Neither a point request nor a
global catalog permits allocating an unrestricted native raster.

## Use in forecasts

The [refinement producer](../refinement/README.md) prepares the configured zones
from one pinned global catalog before weather acquisition. It reuses immutable
terrain arrays and stages them with their masks in the shared build artifact.
Shards validate and load those local inputs once, with memory reserved. A model
with no intersecting zones acquires no terrain. [Operations](../../../../docs/operations.md#terrain-data)
owns the hosted catalog default and override; [development](../../../../docs/development.md#build-a-real-forecast)
covers the local `--terrain-catalog-ref` option.

The separate `--terrain-ref PATH` option loads an already staged native-grid
reference. The hosted `terrain-inputs` JSON model map stages the equivalent
references. Their grids must match their forecast products; these optional
inputs retain their existing plan, recipe and source provenance identity.
They do not replace model terrain or the catalog for configured refinements.

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

## Ownership and lifecycle

- [contract.ts](contract.ts): source meaning, geometry, identities and admission.
- [source.ts](source.ts), [ingest.ts](ingest.ts), [repack.py](repack.py): source
  access, resumable import and lossless packing.
- [reader.ts](reader.ts): native windows, seams, sampling, bounded range reads
  and decoded-block reuse for one preparation lifetime.
- [prepare.ts](prepare.ts): sampling recipe and prepared format.
- [staging.ts](staging.ts): verified local transfer and session load.
- [cli.ts](cli.ts): commands; [local-store.ts](local-store.ts) supplies local storage.

All terrain objects live below `terrain/`, outside forecast cleanup. Retain
dataset versions; removal is manual. Arrays commit before their manifest, and
the global catalog commits after its complete inventory. No mutable dataset
pointer is resolved during forecasts. A missing expected tile is an error;
known ocean absence and source nodata remain distinct.

Source identity describes original bytes and physical interpretation; file
checksums describe stored bytes. Lossless repacking can change the latter
without invalidating numerical preparations. Direction, weather, snow, land
cover epochs and trained weights are separate future inputs.

Run `pnpm test apps/batch/src/terrain` for offline TypeScript fixtures. Native
packing tests use the pinned runtime:

```sh
uv run --python 3.12 --with rasterio==1.4.3 --with numpy==2.2.6 \
  python apps/batch/src/terrain/test_repack.py
```
