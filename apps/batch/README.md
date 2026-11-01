# Batch

`@av/batch` turns admitted upstream weather fields into immutable forecast
archives, a numeric block pack and a manifest. Its CLI also validates, publishes,
rolls back and cleans up builds. GFS is the integrated build path; regional
products are deferred in the [roadmap](../../docs/roadmap.md).

Run from the repository root after [setup](../../docs/getting-started.md):

```sh
pnpm run build:sample --model gfs --out output --cache-dir .cache/gfs
```

The command prints the completed manifest path. [src/commands.ts](src/commands.ts) owns
command options; [src/cli.ts](src/cli.ts) dispatches them and [src/build.ts](src/build.ts) owns build orchestration.
Acquisition adapters own source admission, while
[forecast](../../packages/forecast/README.md) owns shared science and sampling.

`buildForecast` consumes a trusted product definition, coverage mask and
[normalized provider](src/providers.ts). Providers return compact Float32 fields in declared
units, binary missing masks and an explicit pressure axis for the requested
active cells. The pipeline validates these boundaries before deriving fields;
provider-specific inventory and encoding details stay inside the adapter.
Build failure receipts retain bounded provider-neutral error codes/messages and
details, the failing phase/hour and the count of fully rendered and hashed frames.

[Capacity admission](src/capacity.ts) runs before acquisition. Each frame uses
one reusable profile scratch array, writes its fields directly into the final
numeric pack, and renders its layers together in tile order. A frame uses inline
rasterization on one available CPU, otherwise up to three workers with immutable
shared input arrays. Layers of the same tile use the same worker. All workers
share a total 24 MiB retained geometry budget and eight admitted raster/encode jobs; raw
and encoded output buffers are counted together. Preflight includes the shared
arrays and 128 MiB of runtime reserve per worker. Official PMTiles conversion and
verification remain required. Completed, failed or cancelled groups terminate
their workers, drain started encodes, close SQLite handles and remove temporary
databases. Renderer stage times are accumulated work; the build render phase
records elapsed time.
`pnpm capacity` reports that complete current-product working set, its budget and
effective worker count separately from hypothetical frame/layer/model growth.

Workers load the pure raster module; codecs, SQLite and archive operations stay
in the parent. The worker reserve is an admission estimate, not an operating-system
RSS cap; it conservatively overlaps some runtime allocations counted elsewhere.
Projected 512×512 sampling plans exceed an 8 MiB worker cache slice and are
recomputed when they do not fit. The offline Lambert fixture proves correctness;
cache tuning for a future live projected product is intentionally deferred until
that product has its own measured resource budget.

The version-3 manifest binds the recipe, source revision and lockfile, scientific
method, immutable layer/palette descriptors and content-addressed coverage.
Numeric bytes and every tile address are validated before publication.
CLI validation and smoke checks resolve the build's own immutable coverage and
verify its provenance, rather than depending on bundled current coverage.
Local artifact reads use opened-file size bounds, and archive validation caches a
bounded number of successful or in-flight content checks. Publication rules and
workflow authority are documented in [operations](../../docs/operations.md). Publication and serving
share the byte/JSON-structure limits in [contracts/json.ts](../../packages/contracts/src/json.ts).
Cleanup reports listed, protected, unreferenced, eligible and deleted build-prefix
objects with known bytes and explicit unknown-size counts. A failed deletion has
unknown progress because the provider may have removed some objects. The publisher
includes this summary in its maintenance receipt. Rollback and cleanup write
`output/maintenance.json` before remote work, update it on cancellation and retain
confirmed completion separately from cancellation. Rollback CAS outcomes remain
`unconfirmed` until the write succeeds or the authoritative pointer is reconciled.
The maintenance workflow uploads these bounded receipts on success or failure. These are bounded
observations of `builds/<model>/`, not an inventory of the whole bucket.

Re-running the same forecast workflow run replaces that run's receipt and full-build
artifacts. Resume therefore downloads its most recently retained artifact; it still
checks source-workflow identity, recipe compatibility and complete local validation.


Evidence tools run from the repository root with
`pnpm exec node --import tsx scripts/<tool>.ts --help`:

- `benchmark-acquisition.ts` measures cached acquisition or fills a fresh cache
  with `--online --hours all`, without rendering. Its JSON records source/array
  fingerprints, packing counts, transport/cache activity, CPU, elapsed time and
  process peak RSS.
- `benchmark-foundations.ts` compares packing, profile scratch and encoder
  candidates; `benchmark-render.ts` measures raster stages or grouped archives;
  `benchmark-archive-dedup.ts` compares the official converter's deduplication.
  Each emits one first-operation run and five warm runs, with equality checks.
  The foundation microbenchmark also observes V8 GC without forcing collection
  and counts input-level object/array construction. Memory snapshots are not
  allocated-byte measurements; counts exclude science-kernel/runtime allocations.
- `benchmark-raster-workers.ts` records the worker admission experiment against
  inline rendering, with shared inputs, a fixed queue/cache budget, worker startup
  separated from raster timing, process RSS and exact RGBA hashes for all runs.
- `compare-builds.ts` writes a full comparison receipt after byte-exact sample
  comparison, source-frame receipt comparison excluding capture timestamps, and
  decoded RGBA comparison at every expected archive address. Archive ordering
  and compressed bytes may differ.
- `benchmark-builds.ts` runs five sequential baseline/candidate pairs against a
  shared pinned cache, alternating their order. It checks frozen source hashes,
  requires zero network acquisition, preserves per-run outputs/logs and records
  medians, ranges and paired timing changes in `receipt.json`. Candidate builds
  must pass the full performance budget; baseline budget failures remain visible
  for comparison. Supply `--pixel-proof` to bind each repeat's numeric/archive
  hashes to a completed exhaustive comparison. `--resume` preserves interrupted
  attempts and continues incomplete pairs with unchanged sources/configuration.
- `qualify-publication.ts` exercises the real publication, conditional-write,
  rollback and cleanup algorithms from the staging maintenance workflow. Every
  storage operation is confined to `qualification/<random-uuid>/`; the final
  receipt proves that namespace was deleted and is empty. Its maintenance test
  explicitly advances a logical clock past the orphan grace period and does not
  claim proof using objects aged for 24 real hours. Memory-store test receipts
  identify their backend and do not substitute for the R2 workflow receipt.

First-operation microbenchmarks do not imply cold OS caches. A network-cold
acquisition requires a new empty cache directory. Microbenchmark results are
stage evidence; the full-build wall-clock and RSS gates remain authoritative.

Follow [getting started](../../docs/getting-started.md) to validate and inspect a
build, [operations](../../docs/operations.md) to publish or recover one, and
[development](../../docs/development.md) to extend or verify the pipeline.
