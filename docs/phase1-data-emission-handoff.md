# Phase 1 data emission handoff

Emit native atmospheric profiles and point diagnostics from each existing GFS,
ICON-EU and RRFS acquisition, preserving the published lift maps.

```sh
pnpm test
pnpm verify
```

[Architecture](architecture.md) owns package boundaries. [Build admission](../apps/batch/src/capacity.ts)
and [serving budgets](serving-budgets.md) own resource limits. Each milestone
requires correctness, compatibility and performance reviews before proceeding.
Unchecked gates remain required work.

## 1. Freeze contracts and rollout

- [x] Record current retained manifests, API responses, native/fine lift values,
  source receipts and capacity measurements for all three models.
- [x] Add descriptor delivery (`tiles-and-samples` or `samples-only`) with legacy
  omission meaning tile delivery. Require palettes for rendered layers. Keep
  layer selection, templates, TileJSON and prefetch restricted to rendered layers.
- [x] Separate scalar channel counts, rendered artifact counts and workflow job
  counts. Give each limit one owner; retain current resource limits until a
  measured caller requires a change.
- [x] Define runtime-validated `/samples` and `/profile` responses in
  [`@av/contracts`](../packages/contracts/README.md), including units, vertical
  reference, missing values, build identity and expiry.
- [x] Preserve retained version-3/4/5 reads. Test older descriptor snapshots
  against API product validation before changing registry descriptors or layers:
  [`checkProduct`](../apps/api/src/publication.ts) validates the manifest’s
  declared trusted layer subset and retained method snapshots.
- [x] Deploy compatible API and browser readers before enabling new writers.
  Test mixed old/new builds, retained URLs and rollback. Publish a new format
  version if strict existing readers cannot safely admit the extension.

## 2. Add the scalar and profile storage paths

Keep the two fine channels (`usable-lift-msl`, `usable-lift-agl`) and rendered
native `precip-rate`. Add these 17 sample-only native channels (18 native channels including precipitation):

- Thermal/flux: `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`,
  `sensible-heat-flux`, `latent-heat-flux`.
- Cloud/stability: `surface-lcl-msl`, `cape-jkg`, `cloud-cover-total`,
  `cloud-cover-low`.
- Surface: `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`.
- Wind: `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`,
  `bl-mean-wind-v`.

- [x] Extend [`layers.ts`](../packages/contracts/src/layers.ts) and focused
  [`methods.ts`](../packages/contracts/src/methods.ts) descriptors. Record model
  differences, time windows and unavailable inputs explicitly.
- [x] Reuse the block directory, shard writer and range planner for fixed-width
  records. Store record width in the layout/plan so callers cannot decode with a
  different stride. Preserve existing five-byte scalar records.
- [x] Emit profiles for every covered native cell at every retained frame,
  preserving the registry's full selected level axis and all available T/Td/u/v.
  DWD acquires humidity and both wind components at every selected level.
- [x] Define a versioned native profile codec containing model terrain, measured surface pressure and
  ascending known height, decreasing known pressure, temperature, dewpoint,
  Earth-relative u/v and optional omega. Retain nullable core measurements in
  their selected rows so profile readers preserve interior gaps. Specify quantization, sentinel values, overflow handling and
  level-count encoding in code. Support the declared maximum of 256 levels.
- [x] Stream profile records through the shared shard writer using one column
  workspace and a bounded grid-to-active index. Include profile records,
  overlap scratch and transposition in admission; keep whole-domain coverage.
- [x] Validate profile frame partitions, coverage/grid identity, exact byte
  counts, shard keys and hashes. Include profiles in receipts, upload,
  publication verification, rollback, retention and cleanup.
- [x] Test scalar byte compatibility, raw record round trips, malformed records,
  incomplete partitions, halo equality, cancellation and cleanup.

## 3. Acquire and normalize the additional inputs

- [x] Add typed optional surface/level fields at the
  [`NormalizedFrame`](../packages/forecast/src/inputs.ts) boundary with
  table-driven shape and missingness validation. Extend direct-target buffer
  allocation, worker transfer/alias checks and capacity accounting for them.
- [x] Extend both adapters' strict source schemas and field inventories. Verify
  parameter, level, unit, scan direction, vector orientation and statistical
  window from encoded GRIB metadata for every newly admitted field.
- [x] Acquire NOAA humidity, winds, pressure, gust, PBL, CAPE, clouds and
  profile omega where supported; acquire DWD humidity, winds, pressure, gust, PBL, CAPE, clouds and
  precipitation. Unsupported fields remain unavailable with recorded capability.
- [x] Rotate projected grid-relative vectors at normalization; retain Earth-relative
  u/v through interpolation. ICON-EU template 3.0 shares the Earth basis;
  component flags and scan direction preserve east/north signs.
- [x] Recover accumulated precipitation and averaged flux windows using the
  existing interval kernel. Preserve native cloud averaging and gust maximum
  windows in descriptors and provenance.
- [x] Bound acquisition concurrency, retained companion bytes and decoder work.
  Introduce range coalescing or decode workers only with before/after evidence
  and explicit byte, cancellation and lifecycle bounds.
- [x] Retain all forecast hours needed by synoptic/profile callers. Update
  [`resolveProductFrameHours`](../packages/forecast/src/daylight.ts) and model
  policies; the registered point timelines retain nighttime frames.
- [x] Run live `pnpm input:proof --model MODEL --cache-dir .cache/MODEL` for
  GFS, ICON-EU and RRFS; retain representative encoded fixtures and receipts.

Live `input:proof` checks on 2026-11-05 admitted the registered 20-channel
products at one public cell each for the 12 UTC cycle, lead 6: 123 GFS fields,
199 ICON-EU objects and 165 RRFS fields. Horizon inventories contain every
configured GFS field at
27/120/123/384 and every RRFS field at 48. Encoded ICON-EU 48/47 flux and
precipitation records recover one-hour windows; MH is instantaneous and VMAX is
a trailing-hour maximum. NOAA gusts remain instantaneous. RRFS DZDT uses aligned
same-level pressure/temperature; GFS and ICON-EU omega remain unavailable.

## 4. Derive diagnostics with explicit native coordinates

- [x] Keep the existing fine-column solver and its 1.2 m/s lift outputs
  unchanged. Version the fine method when adding available positive-weight
  native cloud support flags. Gate convective outputs by daylight; emit precipitation, synoptic
  fields, LCL and profiles throughout the retained timeline.
- [x] Add tested Bolton LCL, humidity conversions and omega conversion to
  [`@av/thermodynamics`](../packages/thermodynamics/README.md), reusing existing
  constants and conversions. Follow its established invalid-input convention.
- [x] Add native column diagnostics for pressure-weighted mixed-layer LCL,
  effective cloud limit, BL vector means and cloud regime flags. Retain mixed-
  layer/cloud-limit diagnostics internally for flags and profile-derived views.
  Document integration bounds and missing-level behavior in their public types.
- [x] Preserve positive dry depth and w* below the existing map sink threshold;
  these values are required to recover lift for lower sink rates. Represent
  physical zero convection separately from missing inputs and map no-lift status.
- [x] Keep native model terrain in the profile header. Derive altitude views
  from that terrain and the same native column's scalars. Fine DEM terrain
  retains its separate coordinate reference.
- [x] Expose one pure `deriveSoaringViews` with explicit optional basis inputs:
  1.0/1.143 m/s usable tops, dry hcrit, Cu/OD potentials, wind speeds/directions,
  vector shear and buoyancy/shear ratio. Return missing dependent views when
  basis inputs are absent. Full native altitude views come from `/profile`.
- [x] Allocate sample-only fields compactly. Include profile workspaces, raw
  decode bytes and worker copies in peak-memory admission. Admission selects one
  acquired frame when prefetch would exceed the existing 2 GiB process budget.

## 5. Wire build assembly and bounded serving

- [x] Separate rendered layer counts from scalar counts across sequential and
  parallel builds, summaries, archive validation and manifest construction.
- [x] Pass actual frame-group lengths to shard layouts. Planning may estimate
  the largest worker group; a worker already receives its subset of hours and
  must use that length directly. Sequential builds retain their full length.
- [x] Admit profile and scalar storage, acquisition, decoding and all-frame
  reads before fetching weather. Verify generated manifests and provenance fit
  their byte/token/container bounds; shard counts can exceed JSON container caps.
  Enforce aggregate numeric bytes before acquisition and after assembly.
- [x] Allow `/sample` to read declared sample-only layers without requiring a
  PMTiles artifact. Keep unknown frame/layer rejection explicit.
- [x] Add `/samples` with at most 64 coordinate pairs, stable point identity and
  canonical queries. Plan/coalesce all ranges before reading. Enforce combined
  point × frame × layer values, range bytes and response allocations; clients
  split larger point/route requests while pinning one build.
- [x] Add `/profile` with an explicit nearest covered native-cell selection,
  its coordinates and terrain. Read profile and scalar records at that same
  cell, across selected frame groups, using the existing four-read request bound.
- [x] Hash response bytes when exposing content-digest verification. Existing
  sample ETags hash canonical URLs and cannot verify offline response content.
- [x] Add OpenAPI routes, shared client helpers and synthetic local fixtures.
  Test unknown/unsupported profiles, expiry, abort, overload and partial storage.

Serving controls cover exact point order, duplicate coalescing, sample-only
layers, map-window absence, nearest native cells, corrupt/truncated packs,
combined range admission, four-read concurrency, cancellation and drained
leases. Independent profile controls retain missing pressure/height/temperature
rows and unknown model ground. Missing thermodynamic measurements stop dependent
integrals while known height/wind data remain usable. Point views use stored
thermal tops and shared profile integrals without another thermal solve.

## Completion and deployment gates

- [x] Unit/schema/codec tests cover LCL, humidity, vector rotation, BL integration,
  quantization and missingness with independent controls.
- [x] Existing fine lift values and rendered artifacts match frozen controls;
  nocturnal synoptic/profile cases pass for regional models.
- [x] `pnpm capacity --model MODEL` passes for every existing model, including
  profiles and all-hour frames, within current build budgets.
- [x] API/workerd tests measure worst-case single profile and multi-point reads;
  combined ranges remain within 256 KiB, with at most four concurrent R2 reads.
  Client batching handles scattered points and all-frame selections.
- [x] `pnpm docs:generate`, `pnpm test`, `pnpm verify` and `pnpm build` pass.
- [x] Independent correctness, performance and simplification reviews have no
  unresolved actionable findings. Record measurements and remaining limitations.
- [x] Push this branch, open and review the PR, resolve CI/review findings and
  merge. Verify the deployed revision, one fresh publication per existing model,
  old retained URLs, nighttime samples, profiles, multi-point reads and rollback.

Production publications, resource measurements and health checks are recorded
in [Phase 3](phase3-models-and-sunlight-handoff.md). Rollback identity, provenance
and CAS controls pass in the publication test suite; retained URLs pass live
readback.

Horizontal convergence, 80 m winds, 925 hPa scalars, CIN, middle/high cloud
channels, BL-top channels and mixed-layer/cloud-limit scalar channels are
outside this phase. Existing GFS, ICON-EU and RRFS are the model scope.
