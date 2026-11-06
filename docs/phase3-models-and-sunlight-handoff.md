# Phase 3 existing-model horizons

Extend GFS, ICON-EU and RRFS point horizons across every covered native cell.
Terrain sunlight is deferred; this cutover retains the existing DEM inputs for
fine lift.

```sh
pnpm test
pnpm verify
pnpm build
```

Complete [Phase 1](phase1-data-emission-handoff.md) and the capability-aware
clients in [Phase 2](phase2-client-ui-cutover-handoff.md) first.
[Architecture](architecture.md) owns package responsibilities. The lean scalar
inventory in Phase 1 remains fixed; full native-cell atmospheric profiles retain
every selected level throughout the published horizon.

## Milestone 1: Separate map and point timelines

- Publish optional `mapFrameCount` for the ordered map prefix; existing manifests
  default to every frame. Configure `forecast.mapEndHour: 24` and select by
  forecast hour. Native samples/profiles retain the complete frame axis; fine
  samples and every tile layer use the prefix.
- Nest profile shards by frame group, retaining full block/byte/digest metadata.
  Real coverage/layout measurements with current capacity metrics: GFS 144
  frames uses 175,006 bytes/11,566 structural tokens; ICON-EU 48 uses
  141,519/8,998; RRFS 48 uses 225,646/13,958. RRFS has 432 profile shards across
  48 frame groups. Its metadata fixture has an 879,394-byte conservative
  decoded estimate and 247,931-byte measured retained V8 parse heap.
  Admit manifests at 16,384 tokens while
  retaining existing byte, container, cache and process budgets.
- Write bounded per-frame provenance chunks and a versioned run index; bind
  every chunk to its frame, digest and byte count during publication and rollback.
- Update artifact enumeration, publication, rollback, shard receipts, assembly,
  sample/profile readers, client frame matching, prefetch and freshness together.
  Return explicit absence outside a surface's available frames.
- Derive fine terrain columns and render tiles within the map window. Emit the
  lean native scalar channels and complete profiles at every covered native
  cell throughout the point timeline. Native thermal tops retain model terrain;
  fine lift keeps its declared terrain reference and map-window availability.
- Select interval support through `sourceIntervalHours`, source metadata and the
  optional `forecast.intervalChange` transition. GFS changes at hour 123 to
  three-hour support; hour 27 retains its hour-26 companion.
  Output schedule gaps and shard boundaries preserve that support. Acquire
  cumulative companions from the same run, field and reset window.
- Bound frame-group channels, profile record sizes, artifacts, request selections,
  response bytes and workflow jobs independently. Account for auxiliary arrays,
  retained geometry, companion buffers, profile streaming, downloads and total
  CPU time in the existing [build](../apps/batch/src/capacity.ts) and
  [serving](serving-budgets.md) budgets. Keep limits backed by measurements.

GFS supports hourly output through hour 120 and three-hour output thereafter
([NOAA](https://www.emc.ncep.noaa.gov/emc/pages/numerical_forecast_systems/gfs.php)).
Hourly through 24 followed by three-hour steps through 384 has 144 frames;
using every positive source hour has 208. Configure the client-required schedule
in the registry. Page point/profile requests within serving budgets, preserving
build identity and native-cell coordinates across pages.

Gate: sequential and parallel builds agree across map-window ends, skipped
hours, source step transitions and shard boundaries. Tile totals stay bounded
when the point horizon grows. Test legacy manifests, expiry and paged profiles.

## Milestone 2: Prove each existing model's extended schedule

- For GFS, ICON-EU and RRFS, verify field availability at schedule transitions
  and the final hour for each configured cycle. Record real encoded fixtures,
  parameter identities, time windows, missing values and byte totals.
- Keep full humidity and Earth-relative U/V profiles on every selected level.
  Retain RRFS same-level DZDT-to-omega normalization; unsupported omega stays
  absent. Compute mixed-layer LCL, effective cloud limit and boundary-layer top
  wind from the requested native profile through shared kernels.
- Admit acquisition, decode and publication costs for the complete covered
  native grid. Stream profile records and bound overlapping acquisition work.
  Profile coverage and level selection remain the published model contract.
- Validate extended immutable payloads and readback before pointer CAS. Compare
  existing map-window results, then verify the final profile hour and point
  diagnostics through both clients.

Live 2026-11-05 inventories contain all 120 configured GFS fields at
27/120/123/384 and all 165 RRFS fields at 48. Encoded GFS windows recover
hourly support through 120 and three-hour support from 123; ICON-EU 48/47
recovers trailing-hour flux/precipitation and RRFS 48 directly supplies 47–48.
Admission with real coverage, provider arrays and 24-hour map prefixes peaks at
2,047,103,276 bytes for GFS, 2,130,306,286 for ICON-EU and 2,040,638,525 for RRFS;
RRFS uses one input frame. Profile output totals 12.73/10.86/27.47 GB respectively.
These totals include auxiliary fields, shared diagnostics, writer buffers and a 256 MiB runtime
reserve. Record actual worker RSS and elapsed time before changing a limit.

Numeric validation and upload share the borrowed workspace in
[`createLocalFileReader`](../apps/batch/src/local-file.ts). Successful shard
receipts record and enforce the process peak after those phases.

GFS uses 72 two-frame groups. ICON-EU and RRFS use 48 one-frame groups, with
parallelism 8/20. Source inputs, tile totals and numeric totals retain their
configured values.

Use a 90-minute elapsed budget for the entire plan. Two-frame
ICON and RRFS workers measured 50m51s and 57m27s of core work, then exhausted
their scoped credentials during post-core work. One-frame groups retain the
existing job, credential and memory bounds.

Start RRFS first. Start ICON after all 48 RRFS build jobs are visible and either
running or passed, with at most 12 running. Keep main stable and avoid
reruns until both publications finish. This stagger stays within 20 active
workers and gives late RRFS map frames more credential headroom.

[Production GFS](https://github.com/jdorrance/av-layers/actions/runs/42124895821)
published all 144 frames through hour 384 with a 24-hour map prefix. Build stamp
to successful publish-step completion took 46m29s; peak worker RSS was
1,705,320,448 bytes. Production checks paged every profile frame, checked native
scalar parity and nighttime values, exercised all three first-frame profile partitions
after scalar reads, and verified map artifacts, provenance and browser paging.

Numeric packs total 20.79/15.95/35.88 GB per build. The configured daily cadence
and seven-day retention project 1.52 TB across the three models. Admission and
assembly enforce the aggregate numeric-byte budget in
[`BUILD_BUDGETS`](../apps/batch/src/capacity.ts); publication and cleanup receipts
record actual bytes, including replaced builds awaiting expiry.
Bucket-level storage capacity is managed operationally from those receipts.

Staging currently serves a legacy GFS build and lacks the global catalog and
prepared terrain. Rollout reuses production's pinned catalog and its immutable
upload/validation gate before changing the retained pointer.

Gate per model: live input proof, numerical parity, measured memory/elapsed time,
verified immutable publication and production browser parity. Windgrams consumer
changes and acquisition retirement remain deferred.

## Completion

After each milestone, independently review numerical contracts, compatibility,
security and performance; remove duplicate owners and unreachable paths.
Run root checks, all three model proofs and AV client browser checks. Include
measured budgets and publication evidence in the PR.
After review and green CI, merge and verify the deployed revision, manifests,
map-window boundaries and extended samples/profiles in production.
