# Whole-domain terrain-column implementation handoff

Implement whole-domain terrain refinement for GFS and ICON-EU and deliver a
ready-to-ship branch with passing checks, complete integration and measured
build/serving evidence.

```sh
git status --short
pnpm exec node --version
pnpm verify
```

## Outcome and execution contract

Carry this work through implementation, integration, numerical comparisons,
full-domain builds, serving checks, documentation and final branch review.
Intermediate experiments and regional prototypes are milestones. Completion
requires the shipping checklist below.

The required shipping configuration excludes Africa and enables terrain-column
MSL/AGL across each product's covered domain: ICON-EU at subdivision factor
`k=5` and GFS at `k=10`. Keep GFS precipitation on its native grid and method.
Keep the current layers, palettes, model selector and public request URLs.

GFS `k=25` is a subsequent promotion requiring its own full-domain build,
coverage-memory and serving evidence. Complete the required configuration
independently. Request-time physics and lossy encoding are outside this branch's
required scope.

Use the existing task branch when it owns this work; otherwise create a
`codex/` branch. Inspect the working tree and preserve concurrent changes.
Commit the completed task in coherent changes. Finish with a clean task diff,
reviewable commits and exact validation results. Merging and production
deployment are separate actions.

Resolve routine implementation choices and continue through all milestones.
If a required input or external service is unavailable, complete independent
work and report the exact missing gate and recovery command. Every required
gate must pass before describing the branch as ready to ship.

## Sources of truth

Read the [architecture](architecture.md), nearest READMEs and public types
before implementation. This handoff was reviewed against `0702cae`; refresh
the inventory from the actual starting checkout.

- [GFS](../packages/contracts/config/models.json) and
  [ICON-EU](../packages/contracts/config/models.json) own native grids,
  levels, coverage policy, layers and forecast hours.
- [Coverage](../packages/contracts/src/coverage.ts),
  [geometry](../packages/contracts/src/geometry.ts),
  [publication](../packages/contracts/src/publication.ts) and
  [formats](../packages/contracts/src/format.ts) own public contracts.
- [Terrain columns](../packages/forecast/src/terrain-column.ts),
  [reconstructed profiles](../packages/soaring/src/column.ts) and
  [terrain clearance](../packages/forecast/src/refinement.ts) own the
  numerical reference.
- [Sampling](../packages/forecast/src/sampler.ts) and
  [sample layout](../packages/forecast/src/sample-pack.ts) own interpolation
  and block-range semantics.
- [Build budgets](../apps/batch/src/capacity.ts),
  [terrain inputs](../apps/batch/src/terrain/README.md) and
  [serving budgets](serving-budgets.md) own resource admission.

Generate counts and estimates from code and actual masks. Bind measurements to
the commit, configuration, weather cycle/input identities, terrain catalog hash,
coverage/layout hashes, hardware/runtime and exact commands. Keep estimated
capacity, fixture results and measured full-domain results distinguishable.

## Design decisions

### Coverage and native support

Keep coverage policy in the model configuration. Extend the generator's
configuration boundary to express Africa exclusion, using its pinned Natural
Earth source. Preserve Russia, China, Greenland and Antarctica exclusions.
Record the resolved excluded records and source hash in generated provenance.
Define territorial treatment from that pinned dataset and retain explicit
Canaries/Azores regressions where included by policy.

Apply the existing coastal buffer, excluded-polygon precedence, product bounds,
hole handling and dateline behavior at the fine grid. Fine masks use the
generator's cell-footprint policy. Verify coastline and border changes against
the intended policy. A hierarchical shortcut must produce the same result as
direct evaluation of the complete fine-cell footprint.

Define disjoint `output` and `halo` masks, with
`halo = dilate_chebyshev_1(output) minus output`. Define
`active = output | halo` once. Acquire terrain and derive results for every
active fine cell. Public admission uses output coverage.

Derive native acquisition support from the union of positive-weight native
donors required by all active fine targets, plus existing native-layer needs.
Validate those donor indices against normalized `activeIndices`. Fine border
strips can require support beyond the previous native halo; include regression
cases for exclusions, enclaves and narrow coastlines.

Keep native acquisition geometry separate from the published fine grid.
Derive fine spacing and dimensions from the configured native grid and `k`:

- `dxFine = dxNative / k`, `dyFine = dyNative / k`.
- `heightFine = (heightNative - 1) * k + 1`.
- Wrapping width: `widthFine = widthNative * k`.
- Regional width: `widthFine = (widthNative - 1) * k + 1`.

Assign the terminal south row and regional east column explicitly, accessing
only positive-weight donors. Preserve longitude wrap and coordinate snapping.
Describe resolution in degrees; ground spacing comes from grid geometry.

### Numerical equivalence

Preserve donor admission, positive-weight contributor order, native-ground
identity, atmospheric-top checks, support-entry left/right limits, surface
transfer, pressure/humidity closure, daylight evaluation, fallback eligibility,
support flags and Float32 write order.

Cache candidate knots, donor temperatures and support masks per native quad.
At each knot, renormalize the original horizontal weights over the supported
positive-weight donors. Filter knots by the target's active donor set and
height range. Preserve missing zero-weight-neighbor behavior.

Use the reference coordinate-to-weight arithmetic and accumulation order when
claiming bitwise parity. Per-axis tables can replace per-cell mappings while
preserving the reference geographic conversion and snapping. Validate values
and flags against the reference at the same target coordinates.

Extract the current clearance cell operation into a shared private helper.
Evaluate it lazily when reconstruction reports
`belowGroundBridgeExceeded`, using same-frame diagnostics and native flags.
Preserve mixed-branch rejection, support propagation, usable-depth calculation
and Float32 rounding from its owner. Retain the distinct ground environments
used by parcel solving and pressure/humidity closure.

Remove both per-target contributor mappings and whole-fine-grid fallback
fields from production. Keep native diagnostics and donor caches within
explicit lifetimes.

### Sparse fields, coverage and terrain

Introduce one packed field/sampling boundary using Float32 values and existing
status/support flags. Lift units remain metres MSL/AGL. Preserve the five-byte
Float32-plus-flag sample record for this implementation.

Use sparse active-block coverage with a compact directory and exact per-block
output/halo masks. Keep the binary schema, validation and lookup algorithm in
code. Use deterministic block ordering and bind terrain and sample layouts to
the coverage identity. Bounds and checked arithmetic must protect malformed
directories, offsets and dimensions.

Raster workers share immutable packed field and coverage buffers. Account for
actual copies, worker runtimes and frame-buffer reuse. Reuse a buffer only after
packing and every raster reader have finished. Translate prepared sampling
indices to packed offsets without dense fine-grid expansion.

Group DEM requests by required source COG blocks, including interpolation
across asset seams. Admit batches by target points, decoded pixels, transferred
bytes, cache bytes and concurrency. Track whole-preparation totals and deadlines
across reader lifetimes. A geographic window alone cannot establish those
bounds.

Prepare terrain for `output | halo`, preserving nodata/ocean behavior and
validity. Bind prepared artifacts to catalog data identity, target grid,
resampling method, coverage hash and layout version. Stage immutable references
and verify them before reuse. Record cold preparation and cached reuse costs.

### Sample packs and API

Publish immutable pre-solved samples from the same fields and DEM lattice used
for rasterization. Preserve single-frame, frame-list, `frame=all`, layer
selection, no-lift, unavailable, support and nearest-fallback behavior through
the shared sampler.

Each v5 layer belongs to exactly one numerical surface: GFS precipitation uses
the native surface; both lift layers use the fine surface. ICON-EU publishes
the fine lift surface. Select the surface by layer, then apply its output mask.
Missing fine values retain their status.

Retain the current 16-cell block core with duplicated right/bottom interpolation
neighbors, normally 17 by 17 stored cells. Preserve regional clipping and
longitude wrap. The first positive contributor owns the stored block and its
complete interpolation neighborhood.

Store cells in block order with all frame/layer channels adjacent within each
cell, preserving the current frame-then-layer channel order. Assign whole
stored blocks to byte-bounded objects. Use 64 MiB as the initial per-object
target, admitting by actual block dimensions, channel count and record size.
Keep GFS precipitation as an explicit native surface in the manifest.

Generate the range planner and byte estimates from the implemented layout.
One selected grid should need one sample range for the selected frames/layers;
sum bytes and reads across selected grids. Test block, macro-directory, shard
and wrap boundaries and the last partial block. Validate the largest supported
frame/layer request.

Write, merge, hash, validate and upload through bounded windows. Bound the
number of resident shard buffers. Replace whole-timeline pack allocations and
dense fine-grid duplicate-cell indexes. Verify duplicated block-halo values
with bounded storage. Separate value/flag arrays require bounded serialization
scratch when writing interleaved records.

Introduce manifest version 5 with explicit grid/layer ownership, coverage and
terrain identities, channel ordering, shard ranges, sizes and digests. Update
all readers, clients, artifact enumeration, publication and operations together.
Validate complete shard coverage, ordering, byte offsets and digests.

Retain version-3/version-4 readers and fixtures for published builds. Preserve
their method and grid descriptors. Keep shared content-addressed coverage and
terrain separate from per-build cleanup; retention must preserve every object
reachable from retained builds and in-progress publication. Test rollback and
failed publication against missing, corrupt and mismatched assets.

## Milestones

Complete each milestone with its relevant tests and a runnable integration
path. Keep the regional path small enough to compare against the reference.

1. **Baseline and policy.** Inventory configs, masks, CLI and artifact readers.
   Record the starting checks. Add Africa policy and regression probes,
   regenerate native masks with the pinned toolchain, and record actual output,
   halo, tile and byte changes. Establish fine-grid and donor-support rules.

2. **Regional end-to-end implementation.** Implement sparse coverage, packed
   Float32 fields, source-block terrain preparation, v5 packs and a local API
   fixture for a representative region. Exercise both lift layers and all
   requested frames through packing, rasterization and point sampling.
   Preserve native precipitation and legacy-build serving.

3. **Equivalent quad derivation.** Compare the packed path against the current
   terrain-column and clearance operations. Add quad reuse and lazy inline
   fallback. Remove replaced mappings and fallback buffers after parity passes.
   Measure kernel and complete-frame costs separately.

4. **Whole-domain build integration.** Connect product configuration, terrain
   staging, recipe identity, sequential builds, frozen plans, parallel shards,
   assembly, validation, raster workers and publication. Enable required
   whole-domain grids in normal build paths. Require prepared terrain for enabled
   grids and fail builds with missing inputs. Recompute covered tiles at existing
   zooms and report actual counts. Remove superseded polygon production
   planning/configuration once callers migrate; retain reachable legacy readers
   and evaluation references.

5. **Compatibility and operations.** Update API, shared clients, preview,
   Windy plugin, fixtures, OpenAPI/reference generation, workflows, cleanup,
   rollback and operational smoke checks. Preserve request/response semantics
   for existing callers. Document reader-before-producer deployment order and
   recovery procedures.

6. **Measured validation and branch completion.** Run full required-domain
   builds for both models using their configured forecast timelines and
   daylight policy. Exercise local publication, rollback and serving on those
   artifacts. Fix failures and regressions, run final checks, review the complete
   diff and commit the ready-to-ship branch.

## Acceptance and evidence

### Numerical and coverage checks

Compare exact Float32 results and flags for both models (GFS pressure levels
and ICON-EU model levels) on real frames and deterministic boundary cases:
native nodes, grid lines, quad interiors, missing zero-weight neighbors, native-ground identity, bridge
endpoints, one-sided support entries, humidity correction boundaries, darkness,
invalid observations, unsupported tops and mixed fallback branches.

Require packed/dense equivalence for coverage lookup, point reduction and
raster RGBA at the same coordinates. Include terminal rows/columns, coastal
buffer, exclusions, inland water, dateline, block corners and shard boundaries.
Validate DEM values for output cells and solved values for halo-only cells.

### Resource and serving checks

Replace rectangular-grid proxies with stored blocks, live bytes and measured
work where the sparse implementation makes that appropriate. Keep code-owned
budgets and documentation synchronized. Justify each raised limit with a
measurement and a complete memory/I/O accounting.

Keep 2 GiB as the initial peak-memory target per preparation, shard and assembly
process/runner. Raster threads share their host process; hosted forecast shards
run on separate runners. Record individual peaks and subprocess/process-tree
memory, plus aggregate compute separately. Use OS high-water measurements
alongside runtime samples.

Measure cold terrain preparation, acquisition, derivation, rasterization,
packing, plan/shard transfer, merge, validation and publication separately.
Record end-to-end wall time, total retained storage, object counts and R2
operations for both models. Use the current operational schedule and workflow
timeouts as acceptance constraints; a 20-minute build is an optimization target.
Record any measured budget adjustment and its cost/freshness rationale.

Exercise the existing serving load profile with cold/warm coverage, retained
builds, both models and largest frame/layer requests. Record range bytes, read
counts, CPU, latency, cache churn, coalescing and total isolate memory. Charge
coverage directories, masks and in-flight loads across concurrent builds/models.
Check current provider limits for the deployed plan before final admission.

### Commands

Run focused tests during implementation. Regenerate reference artifacts when
contracts or CLI behavior change, then run:

```sh
pnpm docs:generate
pnpm verify
pnpm capacity --model gfs
pnpm capacity --model icon-eu
```

Use the implemented build configuration and commands in
[development](development.md) for full builds. Validate each resulting manifest:

```sh
pnpm exec node --import tsx apps/batch/src/cli.ts validate --manifest PATH
```

Record exact reproducible build, benchmark, local serving and rollback commands
with their receipts. Implement and verify any new configuration or CLI boundary
before documenting its invocation.

## Ready-to-ship checklist

- [ ] Whole-domain ICON-EU `k=5` and GFS `k=10` are enabled in the normal
      sequential and hosted build paths, with Africa excluded.
- [ ] Both lift layers use packed Float32 terrain columns and lazy clearance;
      GFS precipitation retains native semantics.
- [ ] Numerical, mask, terrain, raster, sample-range and legacy compatibility
      gates pass on both models.
- [ ] Complete weather runs produce validated, immutable v5 artifacts with
      bounded preparation, packing, assembly, validation and serving memory.
- [ ] Publication failure, resume, retention and rollback checks pass; retained
      builds and shared terrain/coverage remain intact.
- [ ] API, preview and Windy integration pass with unchanged public URLs and
      correct grid/layer descriptors.
- [ ] Full-domain measurements and serving-load receipts identify the tested
      commit and inputs and satisfy the committed budgets.
- [ ] Root checks and explicit capacity checks pass on the final commits;
      required CI jobs pass when available.
- [ ] Documentation, generated references, operational commands and deployment
      order match the implementation; replaced production paths are removed.
- [ ] The complete diff has been reviewed, actionable findings resolved and task
      changes committed. Report branch/commit IDs, validation results, evidence
      paths and the remaining production promotion steps.

A regional prototype, disabled implementation or unrun required acceptance gate
leaves this checklist incomplete. Keep implementation status and evidence in the
[progress record](whole-domain-refinement-progress.md); update it through
completion.
