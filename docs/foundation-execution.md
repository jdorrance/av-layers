# Foundation execution

This is the execution record for [F00–F13](foundation-plan.md). It distinguishes
implemented code from final qualification. New live models and products remain
deferred. A phase is not complete merely because its code exists.

## Baseline and decisions

Execution started from `1d78d1c7f9af4a446d2c5d3d6585c9cde6224c85`, preserving
the intervening native-zoom-7 change. The unchanged checkout passed lint, type
checks and 417 tests. Its admitted GFS workload is 97,032 tile addresses, 24
channels and a 43,835,520-byte numeric pack. The pinned comparison cycle is
`2026-10-30T00:00:00Z`; historical inputs are allowed for comparison, never for
promotion to current latest.

The baseline source is frozen independently of the working checkout. Cold
acquisition, cached compute, local synthetic serving and deployed GFS serving
are separate experiments. Final timings must name the runner, code identity,
inputs and cache state. The [serving budget](serving-budgets.md) declares the
local-memory surrogate before final qualification; it does not claim an
observed production memory peak.

The supplied plan identifies windgrams and skyjuice as first-party sources.
Their referenced commits identify John Dorrance as author. The adaptation
record is corrected in [notices](../THIRD_PARTY_NOTICES.txt); dependency/data
notices and the absence of a new public license grant are preserved.

## Implementation and evidence in progress

- **F00:** scope, current baseline, existing GitHub/Cloudflare access and byte
  budgets established. Staging and production remain separate private buckets.
- **F01:** client schema/identity/completeness checks and publication freshness
  admission implemented. Missing, duplicate, mismatched and malformed samples
  fail closed; selection limits come from the admitted manifest.
- **F02:** mandatory manifest v3, immutable descriptors, recipe/source/lock
  identity, static production registry and normalized provider boundary
  implemented. Static method/input definitions and immutable parameter snapshots share the exact constants used by the kernel. Wire readers validate the stored snapshot without comparing it to current runtime constants. There is no v2 or inline-provenance fallback.
- **F03:** explicit regular and Lambert conformal grids, transform/metric/vector
  tests, composed support halos and content-addressed coverage implemented.
  Tiny varied-capability builds traverse derivation, packing, rendering,
  validation and injected API admission. Production discovery contains GFS only.
- **F04:** direct channel-to-final-pack writing removes the retained flat
  channel stack. The exact 43,835,520-byte pack microbenchmark measured warm
  median 398.5 ms → 106.1 ms; cold process RSS 390.6 → 258.0 MB. Those are
  microbenchmark results, not complete-build claims. Reusable column scratch
  preserves results; its roughly 2.5% timing difference is treated as noise.
- **F05:** bounded acquisition/decode reservations, incremental hashes, typed
  interval handling, transient retry and cancellation implemented. Five runs
  each at concurrency 1/2/4 differed by less than 2% on the cached packing-3
  corpus. Keep two fetch slots and one default J2K worker; no J2K speedup is
  claimed from a corpus without J2K records.
- **F06:** render all selected layers per tile with one shared bounded encode
  queue. A controlled cold-plus-five-warm archive experiment preserved all
  612 decoded tiles and measured warm median 1059.35 → 736.71 ms. Retain the
  mature PMTiles writer. Reject its dedup option for this workload: 1.74% space
  saving cost 15.8% more conversion/verification time. Retain encoder settings;
  the tested effort reduction did not produce a useful improvement. A guarded
  sampler specialization preserves exact arithmetic and reduced representative
  warm raster time by 52–54% in repeated trials. A bounded raster-worker
  candidate measured a further 43.6% stage reduction; full-build qualification
  must establish the combined gain and memory cost. The prior public GitHub
  z7 run hit its 60-minute timeout with no complete artifact; that is a censored
  baseline, not a measured completion time.
- **F07:** create-or-prove immutable objects, byte-bounded uploads, ambiguous
  write reconciliation, same-build resume, useful-horizon checks and serialized
  maintenance implemented. Cleanup has a separate receipt and cannot turn a
  committed publication into a false “upload failed” report. Independent
  review also covers coverage verification during rollback and local-read races.
- **F08:** bounded/coalesced pointer, manifest, coverage and archive reads;
  short negative caching; byte-based caches; decompression limits and request
  counters implemented. Real local workerd overlapping requests survived
  cancellation of the initiating client with one underlying R2 read. Local
  synthetic timings do not close deployed qualification. Historical real-GFS
  warm and response-cache-bypassed runs each completed 3,000 requests with zero
  errors/drops; p95 remained below 15 ms and the sampled allocated-heap
  surrogate below 48 MiB. These local frozen-bundle results are prequalification,
  not remote latency or production peak-memory claims. Producer and serving
  metadata now share the same byte/structure admission policy.
- **F09:** shared API/time/presentation modules and separate map/host
  controllers implemented. Desktop and mobile-layout browser checks cover
  keyboard controls, intervals, aborts, tile failures and expiry. Physical
  mobile proof was explicitly deferred by the user. The first actual Windy 51
  installation succeeded but exposed its different LeafletGL source events,
  missing accessible control names and cold tile bursts exceeding the API's
  four-operation admission limit. The adapters now use supported source events
  and a shared cancellable tile protocol: two active requests, 64 queued,
  three attempts, a ten-second total deadline and a 1-MiB response cap. The
  Worker limits are unchanged. Corrected public-host proof remains required.
- **F10:** `pnpm dev:fixture` uses a tiny, explicitly synthetic local-only
  product and one workerd seeding session. Fourteen identical fixture objects
  seeded in 0.852 s versus 7.800 s through serial CLI processes on macOS arm64.
  Restart, interrupted upload and missing-dependency repair are tested.
- **F11:** final revision freeze, complete real-GFS differential comparison,
  complete-build/resource measurements and deployed load qualification pending.
- **F12:** coordinated remote lifecycle, recovery drills, actual host/device
  checks and two scheduled production publications pending. The physical-device gate is explicitly deferred.
- **F13:** open until the required evidence above is recorded. No “all done”
  claim is made while those gates are open.

## Evidence locations

The first final-source Linux build passed the 20-minute/2-GiB gate in 993,065 ms
with 1,150,156,800 bytes peak RSS. Its same-cycle publication was refused, then
the exact artifact was successfully resumed with explicit replacement intent
in run `41343492447`. Staging deployment `41343866352` and real R2 recovery drill
`41343868747` passed; the drill removed its 60 temporary objects and proved its
namespace empty. A subsequent fresh cycle built and published in run
`41395096711`, with 558,661 ms build time and 1,233,801,216 bytes peak RSS.
These individual runs use different inputs/runners and are not paired speedup
claims. The original local repeated benchmark was interrupted by macOS
low-power sleep before its first reference build completed. It is invalid as
a completed performance observation; hosted matched-pair qualification is
being prepared so it does not depend on laptop power. The client corrections
change the conservative contracts-source recipe fingerprint, so the final
revision still requires a fresh build and the affected deployed checks.

Experiment scripts and tests are committed with their owning components. A [portable prequalification bundle](evidence/foundation-prequalification.json) preserves the principal local receipts, source hashes, methods and limitations. Raw
local receipts live under ignored `output/evidence/foundation*`; release and
monitor receipts are GitHub Actions artifacts. The final qualification record
will identify deployable code separately from later documentation-only commits.

The local Windy asset-server attempt was rejected by automatic approval review
as an unapproved export to Windy.com; no server started. Actual host testing
will use an explicitly authorized public release artifact. A resized desktop
viewport is recorded as a mobile-layout check, not physical-device evidence. The user explicitly deferred physical-device validation on 2026-11-01.
