# Forecast platform foundation implementation plan

Implementation scope amendment, 2026-11-01: the user explicitly deferred the
physical-device gate after no controllable phone or tablet was found. Desktop
and mobile-layout browser checks and the actual Windy host remain required.
Physical-device validation is future work and is not claimed by this milestone.

Status: planned, not executed. Approved scope: platform foundations only; all new forecast products and live model integrations are deferred. Prepared 1 November 2026 against checkout `da4b53d`.

This is the single implementation plan for making the existing GFS service fast, bounded, extensible, recoverable and fully documented. It combines the repository assessment and the supplied performance/refactoring plan, with incorrect claims and unsafe shortcuts resolved below. Completion means the current service runs on the finished foundation and its operational guarantees are demonstrated.

## Completion target

The delivered system keeps one monorepo, one batch CLI, one private object store per environment and one read-only Worker. It has:

- One explicit alpha contract and static capability registry, normalized provider inputs, native geometry and composable support/coverage boundaries.
- The existing GFS scalar products with preserved scientific values, flags and direct-render pixel meaning.
- Bounded packing, decoding, rendering, validation, upload and API memory; meaningful measured performance improvements; no retained full-grid channel stack.
- Immutable build-specific science/render metadata and reproducible lineage.
- Correct sample validation and freshness admission, safe retry/resume, serialized publication/maintenance and actionable monitoring.
- Capability-driven preview and Windy clients, a fast offline development path, executable reference docs and working extension recipes.
- A complete deployed GFS lifecycle, actual client-host checks, two scheduled successful production cycles, recovery evidence and a final completion receipt.

Native LCC and varying-capability fixtures prove infrastructure only. They remain test-only. Do not implement live HRRR, ICON-Armenia, WRF ingestion/execution, profiles.bin, profile endpoints, Skew-T/windgram UI, convergence, ridge exposure, mountain wave, ensembles, moving nests or model blending in this milestone. Keep their design constraints in the extension documentation.

## Execution contract

1. Execute F00 through F13 according to dependencies. Continue across ordinary refactors, test failures and local implementation decisions. Keep one integrator responsible for the combined result.
2. Use small reviewable commits. Separate scientific/contract changes from mechanical movement and optimizations when that helps compare outputs. Preserve unrelated user changes.
3. Documentation, fixtures and receipts are part of each phase; do not postpone them to the end.
4. For a measured candidate, run the bounded experiment and finish with an adopted or rejected decision. Rejected optional optimizations are completed decisions, not unfinished work. Mandatory correctness, resource and operational gates cannot be waived this way.
5. For unchanged science and rendering, preserve exact values/flags and decoded pixels. A binary/archive representation change may change file hashes while retaining those semantics; document the expected difference.
6. Do not change current physical assumptions, tolerances or forecast claims just to improve performance. No new predictive-skill claim is a foundation deliverable.
7. Use the existing deployment environments and credentials only within execution authorization. This plan itself does not deploy or change external state. Once execution is authorized, prepare concrete artifacts and proceed with authorized work; escalate only an actual access/policy decision.
8. If staging/production credentials, physical-device/host access or provenance confirmation are missing, identify the precise blocker early, finish independent work and keep the affected gate open. A mock, skipped check or healthy /healthz response cannot substitute for it.
9. A phase is complete only when its implementation, tests, relevant runtime/deployed checks, documentation and evidence pass. Do not report “all done” with open foundation gates.
10. Keep future features outside the implementation even if they seem convenient to add while touching a module.

## Baseline and acceptance budgets

The review ran lint/type checks and all 417 tests in 37 files successfully. Preview/plugin builds and Worker dry-run bundling completed. These counts are historical baseline evidence, not targets to preserve numerically. The pnpm-managed runtime was Node 22.23.4 even though the parent shell reported Node 20.10.0.

The current capacity calculation is 8 frames × 3 layers, 97,032 tiles at native zoom 7 (refreshed execution baseline 1d78d1c; the planning snapshot had 9,648 tiles at zoom 5), a 43,835,520-byte numeric pack, and a 2,280-byte worst-case point range. The source plan's retained intermediates are 24 × 5,191,200 = 124,588,800 bytes. Removing them does not guarantee an equal RSS reduction. Current hard admission ceilings include 4,000,000 grid cells, 100,000 tiles, 256 MiB pack, 20 minutes elapsed and 2 GiB peak RSS; scope each limit correctly.

Freeze detailed targets in F00 before optimization. Use these starting acceptance rules:

- No unexplained scientific/status/pixel regression. Current scalar point reads retain one bounded numeric range for an admitted request; cold metadata/coverage reads are reported separately.
- Eliminate the full-grid channel-retention stack. Record actual peak RSS, allocations/GC and disk; refuse any admitted workload whose complete predicted working set exceeds its budget.
- On the same pinned inputs/runner, final cached end-to-end median must not regress beyond measured run-to-run noise. Each adopted optimization must show a useful time/memory/disk/size benefit with its tradeoff recorded. Do not count measurement noise as a win.
- Keep current hard limits unless an explicitly measured requirement justifies changing them. Test just-below and just-above limits, including preflight rejection before acquisition.
- Proposed initial staging serving target: 10 requests/second for five minutes, evenly paced 90% tiles, 4% point samples and 6% metadata, at most 20 concurrent requests; sample pacing stays under the current 30/minute per-identity limit. Separately test throttling and a bounded concurrent metadata burst.
- Under that workload, target p95 warm responses ≤250 ms, cold responses ≤1,500 ms from the declared test location, and unexpected 5xx <0.1%. Record network region and request classes separately; these are engineering acceptance targets, not an advertised global SLA.
- Target measured Worker memory ≤96 MiB where runtime telemetry supports it, preserving headroom under the documented 128 MB per-isolate limit. Include all caches, concurrent buffers and runtime overhead. If measurement or a target is infeasible, resolve it explicitly in F00 with a concrete alternative; do not silently loosen it after a failed final run.
- No unbounded object listings, metadata parsing, worker queues, geometry caches or retry loops within the admitted scope. Time-bounded external operations must cancel/reconcile cleanly.
- At least five warm benchmark repetitions and one cold run. Keep cold acquisition, cached compute and deployed serving as distinct measurements.

Measurement definitions for the serving targets:

- Measure elapsed client time through complete body consumption, not TTFB. State load-generator region, payload/request mix, concurrency, runtime revision and whether network transfer is included.
- “Warm” means a verified response-cache hit. The primary “cold” target above means an uncached response with admitted metadata/coverage already warm. Run the five-minute workload separately for these two cases, with at least 100 measured tile and sample responses in each class/case; extend the run within rate limits when counts are insufficient.
- Record observed fresh-isolate requests separately using an initialization marker/telemetry. Do not call a random coordinate a cold isolate. If fewer than 100 fresh-isolate observations are available, report the observations and sample count rather than an unsupported p95; do not substitute them for the defined uncached-response test.
- Prefer actual deployed isolate-memory telemetry. If unavailable, F00 may adopt production-equivalent local runtime profiling plus a conservative complete cache/buffer/worker-set model under the 96-MiB target and deployed stress with no resource-limit errors. Label this as surrogate evidence; it does not establish a measured production peak. Record this alternative before final qualification.

Cloudflare memory is shared by concurrent requests in an isolate, and Cache API contents are local to a data center. A local or single warm request is not the serving proof. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) and [Cache API behavior](https://developers.cloudflare.com/workers/runtime-apis/cache/).

## Implementation phases

Phase owners below are responsibilities for delegation, not additional services or permanent teams. S/M/L describe relative scope, not calendar promises. Implementation progress and evidence are tracked in [foundation execution](foundation-execution.md); unchecked final gates remain open until their evidence exists.

### F00 Freeze scope, evidence and completion budgets

- [ ] Complete and verified

Owner: Integrator. Scope: S. Dependencies: none.

Establish one factual baseline and resolve environmental prerequisites before structural changes.

Implementation:

- Record baseline commit, dirty state, actual pnpm-managed Node/tool versions and configured environments. Preserve unrelated work. Use a codex/ implementation branch and small independently reviewable commits.
- Freeze a compact offline reference corpus: admitted GFS excerpts, normalized columns, scalar output/flag fixtures, direct-render pixels, binary-layout cases and independent decoded expectations. Keep a separate pinned cached real-GFS benchmark dataset outside Git.
- Capture five controlled warm runs and at least one cold-cache run on a named runner. Record stage wall time, CPU/GC, peak RSS, native/worker buffers, temporary disk, artifact bytes and requests. Keep the old 87.2-second result as historical evidence until reproduced.
- Inventory every publication entry point, scheduler, manual CLI path and maintenance actor. Identify staging/production buckets, Worker/Pages, observability access and actual Windy-host access without printing secrets.
- Record benchmark and serving budgets before optimization. Retain current admission ceilings unless a documented workload justifies a change; split per-artifact/job/product/fleet scopes.
- Start provenance/rights reconciliation using the relevant revisions from windgrams and skyjuice. Verify the first-party claim for adapted material, retain third-party notices, and resolve or narrowly record any remaining distribution constraint.
- Define latency as client wall time through full response-body consumption. Separate verified warm response-cache hits, uncached responses with warm metadata, and observed fresh-isolate cases. Establish class-specific sample counts and the documented memory-proof fallback before comparing results.

Exit gate:

- A reproducible baseline receipt and frozen input identities exist; the full current verification passes.
- Offline development and benchmarks can proceed without live NOAA; external credentials/access needed for final proof are identified early.
- Acceptance budgets are committed before results are known; later changes require a recorded explanation and evidence.
- No new models, profiles or physics are counted as foundation work.

Starting code and documentation: [docs/status.md:11](../docs/status.md), [package.json:5](../package.json), [apps/batch/src/capacity.ts:5](../apps/batch/src/capacity.ts), [THIRD_PARTY_NOTICES.txt:1](../THIRD_PARTY_NOTICES.txt).

### F01 Fix current correctness before refactoring

- [ ] Complete and verified

Owner: Contracts and API. Scope: S. Dependencies: F00.

Close the two concrete correctness gaps while the current architecture is easy to compare.

Implementation:

- Parse full point-sample responses through shared validation; require exact requested frame/product membership, uniqueness, coordinates, time metadata, pinned build/method/coverage identity and expiry.
- Enforce product-specific status/value/support consistency. Missing coordinates, missing expiry, empty requested results and duplicate frames must fail explicitly.
- Add a product freshness policy for latest promotion: cycle age, minimum remaining useful horizon and publication deadline. Keep retention expiry separate from meteorological usefulness.
- Permit explicitly historical builds without promoting them. Distinguish upstream not-ready, transport failure, invalid data and exhausted horizon.
- Add focused regression cases for the currently accepted empty sample and a newly built but already stale forecast. Preserve valid partial-query and pinned-build behavior.

Exit gate:

- Malformed or incomplete sample responses cannot enter the UI.
- An exhausted-horizon fallback cannot silently become latest; clients and operations report the correct freshness state.
- Current legitimate GFS values, times, flags and error behavior pass the reference suite.

Starting code and documentation: [packages/contracts/src/client.ts:341](../packages/contracts/src/client.ts), [packages/contracts/src/index.ts:192](../packages/contracts/src/index.ts), [apps/batch/src/publication.ts:23](../apps/batch/src/publication.ts), [apps/batch/src/noaa/discover.ts:12](../apps/batch/src/noaa/discover.ts).

### F02 Reset the alpha contract and establish explicit extension boundaries

- [ ] Complete and verified

Owner: Contracts and science. Scope: M. Dependencies: F01.

Remove GFS delivery assumptions from the platform without building a generic framework.

Implementation:

- Define model family, source configuration, domain/grid, source run, product recipe, publication identity and immutable build attempt. Keep deterministic recipe/input identity separate from execution ID.
- Use one static typed recipe registry for implemented capabilities. Describe required inputs, quantities/units, vertical reference, time support, vector basis when applicable, sampling, status/support meaning, outputs, coverage and resource limits.
- Extract a small adapter/session boundary returning normalized admitted fields. Keep provider-specific inventory/GRIB rules inside NOAA. Keep thermal AGL/MSL as one shared kernel and explicit dependency lists; no per-cell plugin dispatch or universal DAG engine.
- Make product semantics distinct from palette/rendering. Store compact immutable method/render definitions or content-addressed references with each build, including palette boundaries/colors, units and caveats.
- Record source revision/dirty state, dependency/tool identities, source receipts, adapter/configuration, algorithm parameters and geometry/coverage in reproducible build provenance. Replace opaque essential metadata with bounded typed schemas.
- Adopt one new alpha contract and rebuild data for cutover. Delete legacy inline-provenance, old opaque no-lift style branches and unavailable-model scaffolding. Retain explicit format versions, immutable URLs and a coordinated rollback set.
- Design the product inventory so an actual future profile/vector shape can be added without fake scalar layers; implement only the current scalar shape now.

Exit gate:

- A synthetic adapter can supply existing scalar science without importing GFS acquisition types into generic orchestration.
- A test-only scalar recipe with a different frame/layer subset is driven by descriptors rather than API/client hardcoding; it is absent from production discovery.
- Changing normalization, science configuration, geometry or rendering produces the appropriate changed identity; a pinned old build retains its own legend.
- No compatibility reader remains solely for discarded alpha formats.

Starting code and documentation: [packages/contracts/src/index.ts:89](../packages/contracts/src/index.ts), [packages/contracts/src/index.ts:137](../packages/contracts/src/index.ts), [packages/contracts/src/index.ts:188](../packages/contracts/src/index.ts), [apps/batch/src/build.ts:22](../apps/batch/src/build.ts), [apps/api/src/index.ts:322](../apps/api/src/index.ts).

### F03 Make geometry, coverage and support model-independent

- [ ] Complete and verified

Owner: Geometry and storage. Scope: L. Dependencies: F02.

Prove the native-grid seam using offline fixtures while keeping GFS the only live provider.

Implementation:

- Require an explicit grid kind. Implement regular latitude/longitude and a bounded Lambert conformal fixture path with unambiguous projection parameters, first-cell projected origin, signed spacing, dimensions, scan orientation, earth model and periodicity.
- Provide forward/inverse coordinate transforms, neighbor planning and tested rotation/metric helpers. Keep vector basis explicit so later adapters cannot rotate earth-relative inputs twice.
- Preserve separable prepared sampling for GFS. For projected grids use bounded per-tile/batch contributor indices and weights; both projected axes depend on latitude and longitude.
- Separate public output cells O, derived cells D = interpolationSupport(O), and each primitive input support I = operatorSupport(D). Generate composable halos; a two-cell halo is a derived case, not a universal default.
- Treat geographic bounds as a coarse reject/display aid. Precise coverage uses native grid admission and output masks; define wrap and nonperiodic edge rules without extrapolation.
- Generate geometry/coverage descriptors and bitsets from one recipe. Publish them under immutable content identity with hashes, sizes, policy, grid and layout binding.
- Replace GFS globals with one verified coverage/layout resolver. Coalesce loads and bound cache bytes. Publish every coverage dependency before admitting its build. Use no logical-ID-only GFS fallback; any bundled seed must match exact identity and use the same validation.
- Exercise a synthetic LCC domain and a synthetic varying-capability lat/lon domain through existing science, packing, rendering, validation and local API. Keep them out of live catalogs.

Exit gate:

- Independent projection control points pass; round trips alone are insufficient. Test admitted hemisphere/parallel/orientation cases, edges and wraps.
- Independent known grid-to-earth/earth-to-grid vector cases and analytic zero/nonzero metric-derivative fixtures pass, including missing neighbors and regional boundaries; these remain test-only infrastructure checks.
- Whole-domain and chunked-with-support fixture results agree at seams; missing required neighbors remain unavailable.
- Two geometries/coverage identities coexist in one API instance; corrupt/oversized/missing assets fail closed; concurrent cold loads share work and eviction/reload is correct.
- GFS numeric values, flags and direct-render pixels remain identical. Synthetic success is not reported as live HRRR/WRF support.

Starting code and documentation: [packages/contracts/src/index.ts:15](../packages/contracts/src/index.ts), [packages/forecast/src/sampler.ts:128](../packages/forecast/src/sampler.ts), [scripts/masks/build_masks.py:367](../scripts/masks/build_masks.py), [apps/batch/src/validate.ts:59](../apps/batch/src/validate.ts), [apps/api/src/index.ts:53](../apps/api/src/index.ts).

### F04 Remove retained flat channels and reduce hot-loop allocation

- [ ] Complete and verified

Owner: Batch and science. Scope: M. Dependencies: F02.

Take the clear memory win with the smallest implementation that meets admitted budgets.

Implementation:

- Replace flatChannels and final transpose inputs with a pack builder that accepts GridField values/flags directly by channel. Preallocate the admitted final pack once and validate channel completeness/uniqueness.
- Remove the current 24 full-grid intermediate channels totaling 124,588,800 bytes. Describe this as incremental channel writing; the final output still occupies memory and grows with admitted channel count.
- Enforce the complete working-set budget before allocation. Keep the current pack cap; implement file-backed block writing only if an admitted foundation stress case cannot fit a bounded in-memory builder. Do not add both paths speculatively.
- Reuse level scratch storage sized to admitted levels, or use an explicit typed-array/count kernel. Remove the level-object allocation class while preserving below-ground screening and all scientific branches.
- Remove stale scratch references and validate active count. Do not preserve an optional backward-compatibility signature or claim all science allocations disappear.
- Measure packing/derive time, allocation/GC and peak RSS in isolated runs; releasing references does not guarantee immediate garbage collection.

Exit gate:

- Reference sample-pack bytes, flags, order, halo/wrap duplication and point responses remain exact for unchanged layouts.
- Duplicate/missing channel writes, invalid counts/shapes and premature finalization fail.
- All column cases, including varying above-ground counts and missing profiles, retain values/support flags.
- The intermediate retention is structurally eliminated; actual RSS/GC improvements are recorded without an invented minimum saving.

Starting code and documentation: [apps/batch/src/build.ts:30](../apps/batch/src/build.ts), [apps/batch/src/build.ts:67](../apps/batch/src/build.ts), [apps/batch/src/build.ts:97](../apps/batch/src/build.ts), [apps/batch/src/sample-pack.ts:40](../apps/batch/src/sample-pack.ts).

### F05 Bound and simplify acquisition, decoding and diagnostics

- [ ] Complete and verified

Owner: NOAA adapter. Scope: M. Dependencies: F02, F04.

Make independent input work concurrent only where throughput and memory measurements support it.

Implementation:

- Share admitted field loading/inspection between acquisition and input-proof diagnostics. Preserve proof-specific reporting and failure context; remove genuinely unreferenced overloads/assets after checking every caller.
- Use the recipe as the authority for required inputs and schedules. Acquire/decode shared primitives once per bounded frame/chunk; preserve Float64 accumulation-window recovery until final storage conversion.
- Move independent instantaneous decode/compaction into bounded prefetch tasks. Benchmark 1/2/4 job/worker settings within actual CPU/memory limits; avoid a minimum of two workers on a one-core runner.
- Charge reservations for compressed bytes, transferred codestream/indices, worker/native state, decoded arrays/masks and completed unconsumed results. Keep receipt/output ordering deterministic.
- Add bounded transient retries with jitter, deadlines and cancellation. Refresh incomplete inventories deliberately; keep scientific metadata/content conflicts terminal.
- Replace metadata/encoding Buffer.concat hashing with ordered incremental hash updates. Preserve digests and measure actual bytes avoided; section 7 compressed payload is not in these concatenations.
- Emit structured acquisition/normalization quality reasons and failure receipts. Propagate cancellation, stop scheduling after failure, and drain/close worker pools.
- Record a final adopted/rejected decision for concurrency variants. The installed default codec is meteo.j2k; do not label it OpenJPEG without explicitly changing and validating the codec.

Exit gate:

- Inputs, numerical outputs and essential receipts match reference behavior; Float64 interval precision is retained.
- Chosen concurrency shows useful worker overlap without exceeding the complete job budget; otherwise one worker is the documented final choice.
- Transient failures recover within deadline; corruption does not retry into acceptance or stale promotion.
- Failed/cancelled sessions leave no active jobs or unbounded buffers. Proof and build paths exercise the same admission rules.

Starting code and documentation: [apps/batch/src/noaa/acquire.ts:239](../apps/batch/src/noaa/acquire.ts), [apps/batch/src/noaa/sampling.ts:40](../apps/batch/src/noaa/sampling.ts), [apps/batch/src/noaa/prefetch.ts:1](../apps/batch/src/noaa/prefetch.ts), [apps/batch/src/noaa/admission.ts:210](../apps/batch/src/noaa/admission.ts), [apps/batch/src/noaa/prove.ts:1](../apps/batch/src/noaa/prove.ts).

### F06 Optimize rendering and archive validation without changing meaning

- [ ] Complete and verified

Owner: Rendering and artifacts. Scope: M. Dependencies: F03, F04.

Improve measured hot spots while retaining the current direct sampling and mature archive writer.

Implementation:

- Measure raster, encoding, SQLite, conversion and verification independently. Preserve the current four-quarter-sample scalar-to-palette and premultiplied-alpha method at every zoom.
- Implement or reject a conservative blank fast path based on actual prepared contributors and current product semantics. Include halos, wrapped columns, nearest-neighbor missingness behavior and palette thresholds. Do not bound projected support using corners alone.
- Keep official PMTiles conversion and independent verification. Benchmark supported archive deduplication before custom serialization; retain or change the existing no-dedup setting based on total time/size/memory.
- Where beneficial, cache validated WebP content by bounded digest identity and coalesce pending verification. Validate every tile address even when payloads repeat; equal lengths are not equal content.
- Evaluate bounded CPU workers or traversal improvements only if rasterization remains dominant. Preserve memory accounting and deterministic output.
- Reject bottom-up color downsampling and the proposed hand-written in-memory PMTiles writer from this foundation milestone. Close these decisions explicitly rather than leaving implementation TODOs.

Exit gate:

- GFS RGBA/pixel and scalar parity passes day/night, wet/dry, threshold, no-lift, missingness, coverage-edge and dateline cases.
- Every expected tile address is checked; repeated corrupt content, missing aliases and malformed archives fail.
- Official verifier and independent JS reader pass. Archive byte hashes may change with dedup; numeric bytes and decoded pixels may not.
- Each candidate optimization has a measured final decision; no speculative speedup percentage or custom-format maintenance is introduced.

Starting code and documentation: [apps/batch/src/render.ts:45](../apps/batch/src/render.ts), [apps/batch/src/render.ts:97](../apps/batch/src/render.ts), [apps/batch/src/render.ts:182](../apps/batch/src/render.ts), [apps/batch/src/validate.ts:83](../apps/batch/src/validate.ts).

### F07 Make publication, retry and maintenance an explicit protocol

- [ ] Complete and verified

Owner: Publication and operations. Scope: M. Dependencies: F02, F03, F04.

Finish crash recovery and storage lifecycle before making more work publishable.

Implementation:

- Bound hashing, validation and upload memory across concurrent operations by bytes, not just task count. Stream or chunk only where needed; preserve verified single-PUT checksum semantics while admitted artifacts fit.
- Make exact existing immutable objects reusable after partial/ambiguous uploads by verified digest/content identity and size. Conflicting bytes remain an error.
- Upload verified coverage dependencies, artifacts and provenance before manifest and final pointer CAS. Reconcile a timeout/cancellation after commit against authoritative pointer state.
- Write publication success immediately after confirmed commit. Keep cleanup outcome and failed cleanup receipts separate so maintenance failure cannot trigger republishing.
- Declare CI as the single normal publication authority, with one environment/publication serialization key shared by build, rollback and cleanup. Document and enforce maintenance exclusion for break-glass/manual publishers; do not pass true merely because one workflow group exists.
- Automate periodic/post-publication cleanup only under that enforceable ownership protocol. Protect latest/retained/active work, preserve a grace period and retry deletions safely. Initially retain shared content-addressed coverage; do not add cross-build coverage GC.
- Report deleted object count correctly. Record failed/orphan artifacts and retention cost. Page listing/deletion if admitted volume requires it.
- Produce a final receipt on success, failure and cancellation. Cancellation observed before commit leaves latest unchanged; ambiguous post-commit outcomes are reconciled and never delete referenced data.
- Deploy isolated staging candidates for this phase's integrity, retry, rollback and deletion drills under execution authorization. F12 repeats the checks against the final integrated release; early staging validation does not depend on F12.

Exit gate:

- Tests inject failure/timeout at every artifact and commit boundary; retries neither overwrite content nor unnecessarily rerun science.
- Concurrent publishers have one winner; rollback/cleanup cannot race the declared writer authority.
- Interrupted/partially failed cleanup is safe, and publish-success/cleanup-failure is reported correctly.
- Staging integrity, rollback and deletion drills pass before production maintenance is enabled.

Starting code and documentation: [apps/batch/src/publication.ts:43](../apps/batch/src/publication.ts), [apps/batch/src/publication.ts:61](../apps/batch/src/publication.ts), [apps/batch/src/publication.ts:130](../apps/batch/src/publication.ts), [scripts/build-and-publish.ts:22](../scripts/build-and-publish.ts), [apps/batch/src/storage.ts:53](../apps/batch/src/storage.ts).

### F08 Bound the full serving path and storage amplification

- [ ] Complete and verified

Owner: API. Scope: M. Dependencies: F01, F02, F03.

Ensure cold, concurrent and invalid requests stay predictable as capabilities vary.

Implementation:

- Extract focused publication-reading, HTTP/cache/error and route modules while changing their responsibilities. Preserve one Worker and private R2 access.
- Bound manifests, provenance, coverage, layouts, directory entries, response values and ranges before expensive parsing/allocation. Use count/byte/age limits with immutable identities.
- Coalesce identical metadata/coverage requests. Add short bounded negative caching and refresh coalescing for unavailable publications/unknown builds while preserving declared discovery latency.
- Measure PMTiles header/root/leaf behavior and select a cache policy from bytes and read amplification; do not assume 1,024 entries guarantees no eviction.
- Add per-request-class timing/read-byte/cache/error metrics and stable problem codes. Keep healthz cheap and distinguish liveness from freshness/data availability.
- Start baseline cold/warm/random-point/mixed-build load tests now; run them again after cache changes. Verify 304, HEAD, expiry, retention, invalid parameters, rate limits and uncached failure behavior.
- Keep numerical point reads bounded and preserve pinned-build membership/expiry checks even when response data is cached.
- Use isolated staging candidates to measure this phase's cold/warm serving and cache budgets. Keep their data/namespace separate from other candidates and final qualification; F12 repeats the final-release checks.

Exit gate:

- Cold bursts coalesce expected work, random/invalid requests have bounded storage amplification and caches evict safely.
- Total isolate memory under concurrency fits the committed safety budget; range limits alone are not the memory proof.
- Declared latency/error/read-budget targets pass on the named fixture/load, with separate cold and warm results.
- Different synthetic capabilities serve together without GFS singleton state.

Starting code and documentation: [apps/api/src/index.ts:53](../apps/api/src/index.ts), [apps/api/src/index.ts:130](../apps/api/src/index.ts), [apps/api/src/index.ts:152](../apps/api/src/index.ts), [apps/api/src/index.ts:300](../apps/api/src/index.ts), [apps/api/src/pmtiles.ts:9](../apps/api/src/pmtiles.ts).

### F09 Make both clients capability-driven and remove real duplication

- [ ] Complete and verified

Owner: Clients. Scope: M. Dependencies: F01, F02, F08.

Make future scalar additions ordinary while preserving each host's lifecycle.

Implementation:

- Split shared API/time/presentation responsibilities into readable modules with clear exports. Keep browser DOM helpers out of server/scientific imports.
- Share pure legend/diagnostic/series view models first and identical small DOM builders where useful. Keep separate MapLibre/page and Windy/Leaflet/plugin controllers.
- Drive model availability, labels, frames, units, limits, attribution, bounds, method caveats and legends from admitted immutable descriptors; remove raw GFS/count assumptions.
- Add network deadlines and a bounded safe-read retry policy that preserves abort semantics. Distinguish unavailable, outside-domain, no-lift, stale and expired states.
- Make controls keyboard-accessible and labeled; keep units and temporal meaning visible in point results. Preserve cancellation, host time matching, failed tile handling and background-resume expiry.
- Run a real-browser test over the actual local Worker and synthetic capability fixtures, plus the existing focused controller tests. Measure first useful map, interaction and point loading before bundle changes.

Exit gate:

- Current GFS plus varied synthetic frame/layer/grid fixtures render correct units, legend and values without source-specific client edits.
- Rapid switches, out-of-order responses, timeouts, missing tiles and background resume cannot revive an obsolete result.
- Browser/keyboard/mobile-layout checks pass; actual Windy-host integration is included in F12.
- Shared rules have one owner without forcing different host controllers into one abstraction.

Starting code and documentation: [packages/contracts/src/client.ts:112](../packages/contracts/src/client.ts), [packages/contracts/src/client.ts:269](../packages/contracts/src/client.ts), [packages/contracts/src/client.ts:579](../packages/contracts/src/client.ts), [apps/preview/src/main.ts:364](../apps/preview/src/main.ts), [apps/windy-plugin/src/controller.ts:1](../apps/windy-plugin/src/controller.ts).

### F10 Finish offline development, documentation and CI as part of the product

- [ ] Complete and verified

Owner: Developer experience and documentation. Scope: M. Dependencies: F02, F05, F09.

Make the resulting platform understandable and runnable without chat history.

Implementation:

- Provide one pinned-runtime setup path and one tiny clearly labeled offline API/preview fixture. Keep live GFS and deployed verification explicit separate commands.
- Measure local seeding alternatives: prefer a supported single-process path, otherwise small bounded CLI concurrency. Preserve dependency→manifest→pointer ordering and completion markers; retain serial seeding if alternatives do not help safely.
- Use process.execPath only after validating the runtime. Remove npx fallback/tool-version duplication where the pinned workspace runtime supplies the capability.
- Consolidate duplicated NOAA/CLI/client rules and standardize import extensions with actual resolver requirements. Remove unreferenced overloads/files only after checking callers. Organize tests by coherent behavior, not a mandatory 1:1 source/test rule.
- Create one verification entry point without duplicated checks; cancel superseded verification runs, preserve publication serialization, and separate controlled/live checks from the fast offline path.
- Generate API/CLI/capability/units/status reference from executable definitions. Check links, stale generated output and documented offline commands.
- Update architecture, data, science, operations, getting-started, package READMEs, status and roadmap. Add short working extension recipes for provider/scalar/grid/coverage changes, future profile contracts and alpha cutover.
- Resolve rights/provenance wording from F00 evidence and preserve applicable attribution/license text. Add only a few decision records for consequential boundaries and rejected optimizations.
- Remove runtime-affecting experimental paths, dead flags, unused files and temporary compatibility code before F11 qualification. Preserve compact decision/evidence records.

Exit gate:

- After installing the pinned toolchain/dependencies, a clean checkout follows documented commands to serve and test the fixture without NOAA or other runtime network dependencies, using a neutral/offline basemap when disconnected.
- Reference docs match runtime; another contributor can follow the scalar/adapter recipe using a test-only fixture without unrelated edits.
- CI preserves numerical/publication/runtime guarantees with fast feedback; raw test count and negative LOC are not success criteria.
- Local seeding, interrupted/repeated setup and generated-document checks pass; no unresolved foundation TODO is hidden in documentation.

Starting code and documentation: [docs/development.md:37](../docs/development.md), [docs/getting-started.md:40](../docs/getting-started.md), [scripts/sample-preview.ts:40](../scripts/sample-preview.ts), [scripts/operational.test.ts:315](../scripts/operational.test.ts), [.github/workflows/ci.yml:30](../.github/workflows/ci.yml).

### F11 Qualify correctness, capacity and measured performance

- [ ] Complete and verified

Owner: Independent verification. Scope: M. Dependencies: F04, F05, F06, F07, F08, F09, F10.

Prove the assembled foundation, not just individually passing modules.

Implementation:

- Run reference/admission/science/pack/render/API/client tests with the full final contract. Maintain independent scientific/geometry fixtures and diagnostic reasons.
- Run the pinned real-GFS cached benchmark and controlled cold acquisition check; compare phase time, GC/RSS, disk and bytes to F00. Record adopted/rejected decisions for all performance candidates.
- Run admitted stress fixtures near channel/grid/metadata/cache limits and rejected cases just beyond them. Check preflight refusal before expensive work, checked offsets, bounded buffers and cancellation.
- Measure archive retention, failed-build headroom, upload/read operations and temporary disk. Keep per-model/job and fleet projections separate.
- Exercise one real local runtime and browser end to end; compare API samples to expected numeric values and rendered pixels/legend.
- Audit that no fixture-only provider/product is discoverable in production and no future profile/physics implementation slipped into scope.
- Have an independent reviewer inspect correctness, failure recovery, scientific meaning, maintainability and documentation; resolve every actionable foundation finding.
- Freeze and name the qualified deployable-code revision. Any later runtime/dependency/configuration change reruns affected qualification and deployed gates; later evidence-only documentation commits are identified separately.

Exit gate:

- All mandatory checks pass with no unexplained numeric/pixel regression and no unbounded resource path inside admitted workloads.
- The final measurement report states actual gains and tradeoffs; unsupported percentage claims are removed.
- Current hard limits plus committed serving/build budgets pass; changed budgets have explicit evidence and rationale.
- The code, generated docs and extension recipes describe the same final system.

Starting code and documentation: [apps/batch/src/capacity.ts:23](../apps/batch/src/capacity.ts), [apps/batch/src/render.test.ts:192](../apps/batch/src/render.test.ts), [apps/batch/src/build.test.ts:198](../apps/batch/src/build.test.ts), [docs/status.md:11](../docs/status.md).

### F12 Complete the deployed GFS lifecycle and host proof

- [ ] Complete and verified

Owner: Release and operations. Scope: M. Dependencies: F07, F08, F09, F10, F11.

End with the existing GFS service actually operating on the new foundation.

Implementation:

- Deploy matching Worker/clients and a fresh new-contract GFS build through staging. Verify coverage dependencies, checksums/ranges, catalog/latest, samples, tiles, provenance and immutable legend identity.
- Exercise two successive publications, overlapping pinned clients, concurrent publication conflict, interrupted upload/retry, intentional same-cycle replacement, rollback, expiry and cleanup.
- Run bounded declared-load cold/warm tests and observe Worker CPU/memory/read amplification. Record real cache locality; local emulation is not a substitute.
- Exercise standalone preview on desktop and mobile layouts and the actual Windy host. Physical-device validation is explicitly deferred by the scope amendment above. Verify timestamp sync, aborts, deep zoom, tile failures, stale horizon and background lifecycle.
- Enable forecast-health monitoring with actionable runbook links for upstream lag, missed publication, shrinking horizon, integrity failures and cleanup backlog. Keep healthy unchanged state quiet.
- Perform a coordinated alpha production cutover with a verified rollback set; rebuild supported data and discard obsolete contract branches. Run fresh production smoke checks.
- Observe at least two consecutive scheduled production GFS publications, a monitor failure/recovery drill and one serialized maintenance run. Keep public serving enabled only after the new data/Worker/client set agrees.

Exit gate:

- Receipts demonstrate a complete fresh GFS forecast served remotely, not merely a deployed healthy Worker.
- Rollback, race, retry and deletion drills establish the claimed publication protocol.
- Actual Windy-host and desktop/mobile-layout checks are complete and recorded; fixture tests do not close the host gate. No physical-device proof is claimed.
- Two scheduled publication cycles and monitoring/maintenance succeed on the final revision. Missing access or a failed check keeps this phase open.

Starting code and documentation: [docs/status.md:17](../docs/status.md), [docs/operations.md:1](../docs/operations.md), [scripts/smoke-api.ts:122](../scripts/smoke-api.ts), [.github/workflows/forecast.yml:1](../.github/workflows/forecast.yml), [.github/workflows/deploy.yml:1](../.github/workflows/deploy.yml).

### F13 Close the foundation milestone with an evidence-backed handoff

- [ ] Complete and verified

Owner: Integrator and reviewer. Scope: S. Dependencies: F12.

Leave a finished platform and an honest, compact completion record.

Implementation:

- Reconcile every mandatory action, acceptance gate, review finding and source-plan proposal to implemented/verified or explicitly rejected/deferred by this approved scope.
- Publish a completion receipt naming revision, environments, build identities, benchmark/reference inputs, test/runtime/host results, before/after resource measurements and monitoring evidence.
- Update status and roadmap to distinguish completed foundations from deferred live HRRR/ICON/WRF, profiles, convergence, ridge and wave work.
- Reconcile evidence-only documentation and receipts after qualification; do not modify runtime code, dependencies or deployment configuration here. Record the verified deployable-code revision separately from later documentation-only commits.
- Check clean intended diff, no secrets, no accidental generated binaries, no broken documentation links and no undocumented operator action required for routine runs.
- Deliver the runnable commands, architecture/extension recipes, operational dashboard/alerts, rollback procedure and explicit future-work boundary.

Exit gate:

- Every F00–F12 gate is complete; there are no unresolved foundation blockers or unowned follow-ups.
- All optimization decisions are closed and the implementation is committed/reviewable.
- The completion report can be independently followed without this chat.
- Deferred features are clearly named and are not counted as implemented.

Starting code and documentation: [docs/status.md:1](../docs/status.md), [docs/roadmap.md:1](../docs/roadmap.md), [docs/development.md:1](../docs/development.md).

## Parallel execution and integration order

F00 establishes fixtures and prerequisites. F01 is small and should land early. F02 freezes the cross-package contract before parallel implementation diverges.

After F02, geometry/coverage (F03) and packing/science allocation (F04) can proceed independently. Acquisition (F05) follows the normalized input/scratch decisions. Rendering (F06), publication (F07) and serving (F08) can proceed in parallel after their geometry/contract dependencies exist. Keep distinct ownership for shared schemas and integration changes.

Client work (F09) follows the admitted descriptors/API. Documentation and CI work starts alongside each phase and closes in F10. F11 integrates and qualifies the final result. F12 establishes deployed and real-host evidence, including the scheduled-cycle observation window. F13 closes the milestone only after that evidence exists.

Do not schedule every phase as one giant PR. Do not merge independent changes that alter the same contract until the integrator has reconciled them. Preserve a runnable GFS fixture path through each increment.

## Disposition of the supplied plan

These decisions supersede the corresponding prescriptions in the pasted plan. The goal is a completed foundation, not literal implementation of an unsafe or unsupported mechanism.

- **Direct GridField-to-pack writing — Adopt.** Remove retained flat channels; keep one admitted final buffer initially. Call it incremental channel writing, not streaming-to-disk. Escalate to file-backed chunks only if a measured admitted case requires it. Owner phase: F04.
- **Reusable column scratch — Adopt with corrected scope.** Size scratch from admitted levels and validate active count. 37,999,416 is an upper bound before below-ground skips; this removes level-object churn, not all allocations. No compatibility parameter is needed. Owner phase: F04.
- **Concurrent J2K decoding — Measure and decide.** The current decode path is serial despite a two-worker pool. Test 1/2/4 within CPU and complete byte reservations; retain the winning setting or one worker. No 40–60% promise; default codec is meteo.j2k, not OpenJPEG. Owner phase: F05.
- **Incremental GRIB hashing — Adopt.** Preserve ordered digests with successive hash updates. Current concatenations cover sections 1–6 as selected, not section 7 compressed payload; the quoted ~800 KB saving per field is unsupported. Owner phase: F05.
- **Blank-tile fast path — Prove and measure.** Use a conservative proof over all actual contributors for current semantics. If parity or net benefit fails, retain the existing renderer and close the candidate as rejected. No assumed 60–90% gain. Owner phase: F06.
- **Bottom-up color downsampling — Reject from foundation scope.** Averaging child colors changes direct scalar sampling, palette-bin decisions and missingness at a parent zoom. This is a future rendering-method change, not an equivalent optimization. Owner phase: Deferred.
- **Custom in-memory PMTiles writer — Reject as a required foundation.** Retain the mature writer and independent verifier. A short serializer does not cover scalable directory/header/dedup semantics and increases retained-buffer risk. Benchmark existing dedup first. Owner phase: F06.
- **Deduplicated WebP verification — Measure and decide.** Verify every address; use a bounded content-identity cache or supported directory traversal. The current getZxy result does not expose the proposed archive offset:length cache key. Owner phase: F06.
- **Lazy R2 coverage — Adopt.** Address by content identity, verify dependencies before publication, bound and coalesce resolver loads. Avoid a second logical-GFS-ID fallback path. Owner phase: F03 / F08.
- **Lambert geometry — Adopt for an offline infrastructure proof.** Explicit schema, forward/inverse transforms and bounded projected sampling; retain GFS fast path. Does not enable HRRR, ICON or WRF as live products. Owner phase: F03.
- **Adapter/recipe and stencil support — Adopt narrowly.** Plain functions, one static registry, composed input support and fixture-only stencil kernels. Keep existing thermal outputs together. No universal plugin/DAG framework. Owner phase: F02 / F03.
- **profiles.bin, profile endpoint and Int16 encoding — Defer by user scope.** Record query/axis/missingness/quantization constraints; implement no profile artifact or API. Correct the source plan's arithmetic and pressure/layout assumptions. Owner phase: Deferred.
- **Strict 1:1 module/test files and negative LOC — Reject as acceptance criteria.** Organize tests around responsibilities and independent behavior. Measure duplicate rules and change surface, not file symmetry or total lines. Owner phase: F10.
- **Share all client controllers — Modify.** Share API/time/presentation rules and identical small DOM helpers; retain separate MapLibre/page and Windy/plugin controllers. Owner phase: F09.
- **Increase PMTiles cache to 1024 — Replace with measured policy.** Entries include headers, roots and leaves of varying size. Budget bytes and read amplification; safe eviction is expected. Owner phase: F08.
- **Post-publish cleanup(..., true) — Replace with enforced ownership.** A Boolean is not proof all writers are excluded. Inventory writers, use one authority and serialization protocol, and report cleanup separately from publication. Owner phase: F07.
- **Six concurrent local seeding processes — Measure and decide.** Prefer a supported single-process path; benchmark bounded concurrency only if needed. Preserve ordering, interruption safety and pinned runtime. No promised 35-second to 6-second gain. Owner phase: F10.
- **Clear first-party rights notices — Verify and correct precisely.** Record confirmed ownership/authorization for adapted revisions; preserve provenance and genuine dependency/data notices. Do not remove warnings merely because a sibling directory exists. Owner phase: F00 / F10.

The PMTiles decision follows the [official v3 specification](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md): a complete writer must handle the archive/header/directory invariants, including the root-directory size boundary and leaf directories as needed. Keep format correctness independently verified.

## Deferred feature contracts and corrected profile arithmetic

The foundation documentation must preserve these constraints without implementing the features:

- A future profile product has explicit time/level/variable axes, native location/model elevation, missingness, vertical reference, quality, method and query budgets. Start with nearest native column when the actual product is approved.
- The proposed five-Int16 record contains height, temperature, dew point, U and V, but omits pressure. It only works with an exact shared pressure axis stored elsewhere. Native WRF pressure varies by location/level/time.
- Current coverage contains **210,237** output cells, not 167,679. Eight frames × 21 levels × 10 bytes is 1,680 bytes/point and **353,198,160 bytes total** before status, indexes, headers or block padding. This exceeds today's 256-MiB scalar sample-pack budget and the same limit currently reused for per-artifact uploads. A future profile product needs its own measured storage, upload and query budgets.
- The existing scalar SamplePackLayout stores whole touched blocks and adds neighbor cells. It is not an unchanged output-only, duplication-free profile layout.
- One 1,680-byte read assumes an uncompressed contiguous record and already available metadata/indexes. Block compression changes read amplification. The coverage mask does not cover every point on Earth.
- Int16 needs per-field scale/offset, missing sentinel, rounding, valid range and overflow policy. Do not assume a compression ratio or write custom 12-bit/delta formats before measuring the real query.
- WRF quantities require deliberate conversion of perturbation/base pressure, geopotential, potential temperature, mixing ratio and vector basis. Destaggering, rotation and projection metrics are separate operations. LCC is one supported WRF projection, not all WRF geometry.
- Native convergence, DEM exposure, resolved vertical motion, wave diagnostics and pilot-experienced climb are different quantities; each future method needs its own evidence and limitations.

See [NCAR WRF output definitions](https://www2.mmm.ucar.edu/wrf/site/documentation/users_guide/output_variables.html), [earth-relative wind conversion](https://wrf-python.readthedocs.io/en/latest/user_api/generated/wrf.uvmet.html) and [destaggering](https://wrf-python.readthedocs.io/en/latest/user_api/generated/wrf.destagger.html). Do not publish future capability entries until real adapters and product gates exist.

## Documentation deliverables

Keep the current ownership map and finish every owner:

- README and getting started: exact pinned setup, one offline demo, one verification command, separate real-data path.
- Architecture: domain glossary, package ownership, dependency direction, scalar execution flow, geometry/coverage support, artifact and publication protocols.
- Data guide and generated reference: capability discovery, units, temporal/vertical meaning, absence/quality, limits, immutable legend and freshness semantics.
- Science: existing method equations/assumptions, input mapping, branch policies, interpolation/rendering and independent reference cases. Separate computational validation from forecast-skill claims.
- Operations: publisher authority, scheduling, environment setup, credentials boundaries, freshness monitoring, retry/reconciliation, rollback, cleanup and every alert's recovery action.
- Development: working scalar/adapter/grid/coverage extension recipes, fixture strategy, benchmark commands, generated-doc checks and contribution workflow.
- Package READMEs: short examples and links to authoritative owners; avoid copied reference tables.
- Status and evidence: final revision/build identities, exact measurements, deployed/host proof and remaining future feature boundaries.
- A small set of decision records: alpha contract, native geometry/support, publication authority, bounded artifact strategy and closed optimization decisions.
- Notices: accurate first-party adaptation provenance plus preserved third-party/data obligations.

“Perfectly documented” means a contributor or operator can understand, change, run and recover supported behavior from the repository, and executable checks detect reference drift. It does not mean comments duplicating every line of code.

## Evidence and completion ledger

During execution keep machine-readable receipts under the existing output/evidence area, and check in compact durable receipts under docs/evidence. Keep bulky input/artifact data outside Git with hashes and retrieval instructions. Avoid two independent status sources: the phase checkboxes here track execution; docs/status.md owns demonstrated behavior.

Each phase receipt must identify: phase/revision, input/recipe/build identities, commands and tool versions, result, relevant output comparisons, timings/resources, external environment/host evidence when applicable, documentation changes, reviewer and any unresolved blocker.

Every optimization record must state: hypothesis, controlled baseline, candidate settings, equivalence result, resource/time distribution, tradeoffs, adopted/rejected decision and final code path. Failed experiments are removed from the delivered implementation.

F13's final receipt must link all mandatory evidence, show before/after resource results, list actual deployed endpoints/revisions and successful scheduled runs, and explicitly confirm that deferred providers/products are unavailable. Never record planned checks as passed.

## Reconciliation with the earlier review

All forty review items have a disposition:

- 1–3: F00/F01/F12, complete deployed proof, freshness and response correctness.
- 4–8: F00/F02, explicit identities/semantics/registry, independent corpus and complete provenance.
- 9–13: F00/F02–F05/F11, measured budgets, adapter boundary, native geometry, support and packing.
- 14: future profile/query-shape design constraints documented in F02/F10; profile implementation deferred by user scope.
- 15–19: F04–F07, measured renderer/validation/upload, transport retry, idempotent publication and cancellation/receipts.
- 20–26: F02/F05/F07–F12, bounded serving, quality diagnostics, clients, monitoring, maintenance and alpha deletion.
- 27–34: actual WRF/profile/enhanced-physics implementation deferred. Relevant field/grid/halo/provenance constraints are documented and fixture-proven in F02/F03/F10; no new predictive-skill claim is required.
- 35–40: F00/F07/F10/F13, executable docs, extension recipes, runbooks, offline development, behavioral CI and accurate rights/provenance.

The pasted plan maps as follows: P0.1 → F04; P0.2 → F05; P0.3 → F06 with custom writing/downsampling rejected; P0.4 → F02/F03/F08; P0.5 → F03 fixture proof only; P1.1 → F05/F09/F10; P1.2 → F02/F03 with new science deferred; P1.3 → documented future contract only; P2.1 → F00/F07/F08/F10. Its local-seeding proposal is resolved in F10.

## Executor handoff

Execute this foundation plan to completion, respecting the approved exclusions. Start by refreshing the current checkout and F00 evidence; do not assume this snapshot is still current. Use parallel agents for independent work, retain one integrator, and keep the user informed of meaningful progress.

Continue until every mandatory phase gate is implemented, verified and documented. Use benchmark evidence to close optional optimizations as adopted or rejected. Preserve scientific meaning, immutable publication and bounded resources. Do not substitute mocks for external proof, invent performance claims, or declare success while access-dependent gates remain open.

Deliver the completed platform, verified deployment and concise evidence-backed handoff. No further product expansion is part of this execution.
