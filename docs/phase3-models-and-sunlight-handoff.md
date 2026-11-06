# Phase 3 existing-model horizons

Extend GFS, ICON-EU and RRFS point horizons across every covered native cell.
Terrain sunlight is deferred; this cutover retains the existing DEM inputs for
fine lift.

The rolling-window follow-on keeps each model's window in
[forecast-windows.ts](../packages/contracts/src/forecast-windows.ts); selected
hours, map end, minimum useful horizon and shard counts derive from that entry.
`framesPerShard` selects the maximum compute-group size; the registry derives
the target count. Earlier cutover measurements below record the retained
384/48-hour publications and their execution settings.

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
  default to every frame. Resolve the map window from its configured hours and select by
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
  optional `forecast.intervalChange` transition. The rolling window uses
  one-hour support; hour 27 retains its hour 26 companion.
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
using every positive source hour has 208. Tune the selected schedule in
[forecast-windows.ts](../packages/contracts/src/forecast-windows.ts).
Page point/profile requests within serving budgets, preserving
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

Live 2026-11-05 inventories contained all 120 configured GFS fields at
27/120/123/384 and all 165 RRFS fields at 48. Encoded GFS windows recovered
hourly support through 120 and three-hour support from 123; ICON-EU 48/47
recovered trailing-hour flux/precipitation and RRFS 48 directly supplied 47–48.
Admission with real coverage, provider arrays and 24-hour map prefixes peaked at
2,047,103,276 bytes for GFS, 2,130,306,286 for ICON-EU and 2,040,638,525 for RRFS;
RRFS used one input frame. Profile output totaled 12.73/10.86/27.47 GB respectively.
Working-set estimates included auxiliary fields, shared diagnostics, writer buffers and a 256 MiB runtime
reserve. Record actual worker RSS and elapsed time before changing a limit.

Numeric validation and upload share the borrowed workspace in
[`createLocalFileReader`](../apps/batch/src/local-file.ts). Successful shard
receipts record and enforce the process peak after those phases.

The retained cutover used 72 two-frame GFS groups. ICON-EU and RRFS used 48
one-frame groups, with parallelism 8/20.

The [elapsed build budget](../apps/batch/src/capacity.ts) bounds the entire plan.
Earlier two-frame ICON and RRFS workers measured 50m51s and 57m27s of core work,
then exhausted their scoped credentials during post-core work. The successful
cutover used one-frame groups within the job, credential and memory bounds.

Those runs started RRFS first and admitted ICON after all RRFS build jobs were
running or passed, with at most 12 running. Main stayed stable until both
publications finished; the stagger kept at most 20 workers active.

[Production GFS](https://github.com/jdorrance/av-layers/actions/runs/42124895821)
published all 144 frames through hour 384 with a 24-hour map prefix. Build stamp
to successful publish-step completion took 46m29s; peak worker RSS was
1,705,320,448 bytes. Production checks paged every profile frame, checked native
scalar parity and nighttime values, exercised all three first-frame profile partitions
after scalar reads, and verified map artifacts, provenance and browser paging.
Its 12 two-frame map jobs measured 13m13s–33m30s of core work and
15m47s–37m24s for the complete build step. They rendered two frames per job;
the rolling window's complete all-map run still needs production timing proof.

[Production RRFS](https://github.com/jdorrance/av-layers/actions/runs/42151691053)
published all 48 hourly frames and complete native-cell profiles. All 48 shard
receipts captured the full process peak; the maximum was 2,008,121,344 bytes.
Pre-publication elapsed time was 61m35s, followed by 5m26s of publication work.
API checks cover all nine first-frame profile partitions after scalar reads,
nighttime values and native-only late frames. Mobile checks cover paging, units
and retained map captions. All 39 available prior-hour controls match exactly
across 132 scalar and 351 profile files.

[Production ICON-EU](https://github.com/jdorrance/av-layers/actions/runs/42154667582)
published all 48 hourly frames and complete native-cell profiles. All 48 full
process peaks passed, with a maximum of 1,400,418,304 bytes. Pre-publication time
was 51m48s, followed by 3m12s of publication work. API checks cover all four
first-frame profile partitions; all 18 native channels are valid across all 48
frames at the approximate screenshot location, 40.749°N, 42.4°E.

Those retained builds totaled 20.79/15.95/35.88 GB of numeric packs each. That
cutover's daily cadence and seven-day retention projected 1.52 TB across the
three models. Admission and
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

The original cutover completed 2026-11-06. Independent correctness, resource and
browser reviews passed
for all three models. The [all-model production health run](https://github.com/jdorrance/av-layers/actions/runs/42160468908)
passes freshness, horizon and serving checks. Retained payloads, conditional
requests and response hashes pass live readback. All forecast workers drained
before this completion record was committed.
