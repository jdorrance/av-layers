# Weather data adversarial review

The corrected design is ready for a measured spike; the new wind pipeline has
no end-to-end performance result yet.

```sh
pnpm exec node --import tsx scripts/weather-data-audit.ts > /tmp/weather-data-review.json
diff -u docs/assets/wind-overlay/review-evidence.json /tmp/weather-data-review.json
```

Reviewed against main `b49a3bd` on 2026-11-13, with independent client, serving
and scientific reviews. The branch includes that baseline. The
[plan](weather-data-plan.md) owns the resulting implementation requirements;
[evidence](assets/wind-overlay/review-evidence.json) owns calculations and source hashes.

## Findings resolved in the plan

1. **P1: stale performance baseline.** The previous plan cited the older
   scheduler and missed prepared timeline overviews and front caching. It now
   uses current owners and requires measured bundle increments within both
   startup and combined lazy budgets.
2. **P1: storage blocks could flood HTTP.** A Woodstock desktop z9 envelope
   implied 96 requests before metadata; z8 implied 295. Fixed grouping,
   incremental dispatch and request/byte-based LOD admission replace enqueue-all.
   The audit records grouping's extra bytes alongside its request reduction.
3. **P1: wind memory could stack on top of raster memory.** One owner now counts
   active/replacement fields, raster preparation, decoded targets, GPU textures,
   trails and temporary allocations. Wind fits inside the existing estimate;
   quality and speculation shrink before admission.
4. **P1: fast lift time changes could leave stale wind visible.** Presentation
   now binds the full forecast/height/dependency identity. Matching coarse data
   can display immediately; stale products hide while their replacement loads.
5. **P1: CPU values could disagree with particle motion.** The selected 2D
   lattice is the display authority. Direct column sampling and interpolation
   of its resampled field differ by 10.8 km/h in the executable counterexample.
6. **P1: finite lift values could be mistaken for usable lift.** Target selection
   now follows build-bound scalar status/interpolation, including stored no-lift
   terrain values. The audit checks actual 75% and 50% no-lift neighborhoods.
7. **P2: missing-donor and vertical-gap behavior was unspecified.** The first
   paired-vector method now defines nearest-donor ties, adjacent-level brackets,
   exact-level sampling and the separate Surface mode.
8. **P1: compression could defeat random access or byte limits.** Each chunk
   now compresses independently, with encoded/decoded bounds. Binary transport
   preserves the compressed bytes until worker decoding.
9. **P1: a cold chunk could require full-shard hashing.** Full objects are proved
   during publication. Serving verifies bounded index pages and requested ranges.
   Index paging also prevents multi-megabyte all-time metadata loads.
10. **P1: new numeric routes would inherit cache opt-out.** Successful chunks
    explicitly opt into the front cache. Descriptor/error policy, build expiry,
    deployment identity and early-removal behavior are specified separately.
11. **P2: per-build totals hid cadence/retention cost.** The audit covers all six
    configured models: 67.13 GiB/day and 469.92 GiB over seven days of raw new
    columns. Upload, verification, disk and schedule costs are release gates.
12. **P2: performance acceptance was too vague.** The following gates define
    cold/warm, total-stack, accuracy and resource measurements. Passing existing
    raster tests alone cannot qualify the new numeric path.

These corrections are design requirements. They do not claim that the proposed
runtime behavior has been implemented or measured.

## Release gates

Run the extended preview benchmark on real RRFS Woodstock fields and at least
one model-level source. Include every registered grid/codec configuration in
decode, mask and capacity checks. Record browser/device versions, DPR, viewport,
model/build/frame, active layers and all quality settings with each result.

- **Resident height:** at least 100 changes across the full approved rail, with
  correctness observed from rendered output. p95 input-to-correct-field ≤33 ms
  desktop / ≤67 ms mobile; zero HTTP requests and full-volume uploads while all
  required data are resident. Record the residency preparation cost separately.
- **Cold first display:** at least 20 fresh data-cache runs with a ready basemap.
  Desktop profile: 20 Mbit/s, 50 ms RTT; mobile: 5 Mbit/s, 150 ms RTT on an actual
  phone. First correct wind overview p95 ≤1 s / ≤2 s; admitted native detail
  p95 ≤2 s / ≤5 s. Include descriptor/index dependencies, decode and upload.
  Report full application startup separately, including lazy code transfer.
- **Full enabled stack:** wind, lift, cloud and precipitation at the same time.
  Test rapid scrubs, distant day jumps, eight pans and a 15-minute phone run.
  Zero superseded or incorrectly labelled fields. Prepared full-stack changes
  meet the resident latency bound; unprepared changes expose readiness honestly.
- **Animation:** p95 frame interval ≤16.7 ms desktop / ≤33.4 ms phone at the
  admitted quality. Record dropped frames and sustained behavior after warming
  the device. Paused/off/hidden wind stops its animation work.
- **Accuracy:** decoded CPU versus GPU display components differ by ≤0.01 m/s,
  with identical statuses at control points. Initial field-approximation target
  versus direct original-column sampling: vector error `|v_display − v_reference|`
  p95 ≤0.5 km/h, maximum ≤2 km/h over the valid test corpus. Report direction
  separately; mask tests include boundary ties, missing brackets and no false
  calm. Increase resolution or fail
  the quality gate when terrain/shear cases exceed the bounds. Keep encoding,
  target-height and field-resampling errors separately reported.
- **Memory and lifecycle:** enforce the plan's shared admission before allocation,
  including two time/build identities during replacement. After repeated pan/time
  cycles, retained allocations return within the declared cache budget. Exercise
  WebGL context loss and unsupported devices; fall back to barbs or an available
  2D field without retry loops or a blank map. Count driver/page memory separately
  from logical allocations.
- **Serving:** a cold chunk reads only bounded index pages and its payload.
  Exercise hit/miss, cross-region requests, expiry, early removal and corruption.
  Run the current sustained-load workload with the new product mix; record
  p50/p95, failures, R2 reads/bytes and cache hits. Set a traffic envelope from
  those results before claiming scalable capacity; the current 10 req/s harness
  alone certifies no higher load.
- **Build:** one representative complete publication accounts for logical bytes,
  compressed bytes, temporary disk, per-stage time, peak process memory,
  upload/verification operations and retained storage. Existing build limits
  remain unchanged. The compression/runtime measurement must cover every product
  being enabled, including overviews and scalar companions.

## Evidence available now

The audit script recomputes all configured native coverage layouts and raw column
costs, models aligned viewport grouping, and checks two existing scalar-sampler
cases plus the resampling counterexample. It performs no network or GPU timing.

The [existing timeline results](preview-performance.md) establish current painted
raster performance under their documented synthetic network/device conditions.
They are the regression baseline for this feature. The new encoder, numeric
server route, GPU height pass and integrated mobile viewer still need the release
measurements above.
