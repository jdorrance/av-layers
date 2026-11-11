# Forecast hardening plan

Simplify forecast builds and serving for GFS, ICON-EU, and RRFS while preserving
forecast values, pinned build URLs, and recovery. Start with `pnpm verify` on
the baseline revision. [Architecture](architecture.md) maps the workspace.

## 1. Establish the verification baseline

- Record the revision, runner, pinned Node and pnpm versions, worker count, and
  cache state. Run the current suite on a runner that permits local `workerd`
  and record repeated wall times and slow files. Report timeouts separately
  from successful runs. Vitest file durations overlap. Measure process CPU
  directly if reporting CPU time. Compare the full gate before and after
  moving tests, and report the fast loop separately.
  [Root checks](../README.md#development-checks)
- Extend the [whole-domain parity suite](../apps/batch/src/whole-domain-v5.test.ts).
  Exercise the configured grid and pressure-coordinate combinations with small
  fixtures for wrapping isobaric lat/lon, non-wrapping model-level lat/lon, and
  Lambert isobaric. The [offline provider fixture](../scripts/fixtures/normalized-provider.ts)
  supplies isobaric inputs. Use model-level inputs for the second case. Include
  a wrap seam, output/halo and excluded cells, stored MSL no-lift, terrain
  clearance fallback, and a point beyond the map frame prefix.
- Compare exact scalar/profile bytes for the same layout. Compare decoded
  records across serial and sharded output layouts, and decoded WebP pixels
  unless the archive bytes are stable under the pinned tools. Find artifacts
  through their manifest records. Check status and support flags, frame order,
  units and method descriptors, and pinned samples and profiles. Run one
  build-to-Worker fixture through catalog, latest, tiles, `/sample`, `/samples`,
  `/profile`, and indexed provenance. Freeze fixture times and validate build
  IDs, expiry, and recipe/provenance bindings separately from output parity.
  Source moves change [recipe identity](../apps/batch/src/identity.ts).
- Preserve the [captured retained v5 test](../apps/api/test/retained-v5.test.ts)
  for older layer subsets and manifests without profiles. Keep budget,
  malformed input, abort, stale plan, tamper, publication and rollback
  assertions when replacing fixtures. [Build budgets](../apps/batch/src/capacity.ts)
  and [serving budgets](serving-budgets.md) define the bounds.

## 2. Fix current v5 publication and request handling

- Accept a rendered max zoom below the immutable sparse coverage pyramid's
  max zoom during full publish and rollback. Share the rendered-prefix rule
  with local validation and serving. Keep the coverage hash, key and grid
  checks. Extend the existing frozen-zoom fixture through publish and rollback. Reject builds
  whose rendered zoom exceeds the coverage pyramid.
  [Publish and rollback](../apps/batch/src/publication.ts) ·
  [Local validation](../apps/batch/src/validate.ts) ·
  [Frozen-zoom fixture](../apps/batch/src/whole-domain-v5.test.ts)
- Pass the HTTP abort signal to the tile coverage and archive read waiters.
  Reclaim queued work when callers disconnect and keep shared reads available
  to surviving waiters. Verify a queued abort and a shared read in the real
  Worker. [Tile route](../apps/api/src/index.ts) ·
  [PMTiles reader](../apps/api/src/pmtiles.ts)
- Measure warm point queries with the response cache bypassed. Scalar and
  profile requests repeat layout binding across every sparse block. Reuse
  successful binding for the same admitted surface and verified coverage
  instance, within existing cache lifetimes and byte accounting. Keep
  request-time expiry and admission checks. Exercise cold, warm, corrupt,
  and concurrent loads. Review the repeated v5 artifact validation after
  schema parsing in the same measurement pass.
  [Sparse coverage](../apps/api/src/coverage.ts) ·
  [Profile reader](../apps/api/src/profile.ts) ·
  [Layout validation](../packages/contracts/src/publication.ts)

## 3. Shorten the test loop

- Keep pure and in-memory tests in `pnpm test`. Put real Worker/R2, PMTiles
  subprocess, and Windy bundle checks in `pnpm test:integration` and run both
  through `pnpm verify` and CI. Classify suites by the resources they start,
  including [sample preview](../scripts/sample-preview.test.ts),
  [rendering](../apps/batch/src/render.test.ts), and the
  [Windy bundle test](../apps/windy-plugin/src/bundle.test.ts). Preserve both
  API base cases in the bundle test. Check that every existing suite has one
  project and that new root `tests/*.test.ts` files are discovered if used.
  Compare worker pools and worker counts on the same runner before changing
  defaults. [Vitest config](../vitest.config.ts) owns discovery and concurrency.
- Bound boot, requests, and shutdown in the
  [Worker runtime test](../apps/api/test/runtime.test.ts). Surface startup
  errors promptly. Synchronize the disconnect case on the test Worker's read
  and join state and pass the request signal to the test waiter. Keep the real
  disconnect, Cache API and discovery TTL checks. Reuse the in-memory
  cancellation coverage in [resources.test.ts](../apps/api/test/resources.test.ts).
- Reuse sealed whole-domain builds within a suite for read-only assertions.
  Copy only what a tamper case modifies and isolate each test store. Keep
  cases that exercise fresh acquisition, failure and retry independent.
  Share raster pools only across cases that leave the pool healthy. Check
  aggregate build count before splitting a suite into files.
- In [prepared sampling parity](../packages/forecast/src/prepared.test.ts),
  run exhaustive cases against representatives for each distinct sampler
  policy. Derive or assert the mapping from `LAYERS` so new policies get
  coverage. Include both stored-MSL modes, custom layer specs, support bits,
  invalid values and duplicate wrapped contributors. Measure the parity
  suite and the full test gate after the change.

## 4. Retire legacy publication in two steps

The [configured models](../packages/contracts/config/models.json) select
whole-domain v5. The local sequential writer emits `cell-major-block-shards-v1`
scalar packs and the parallel publisher emits `frame-group-block-shards-v1`.
Both are v5; profiles use their own layout. The run provenance index and its
per-frame receipts also have independent versions.
[Finish](../apps/batch/src/whole-domain/finish.ts) ·
[Serving groups](../apps/batch/src/serving-groups.ts) ·
[Publication schemas](../packages/contracts/src/publication.ts)

### Move remaining writers and fixtures to v5

- Convert [`pnpm dev`](../scripts/dev-fixture.ts) to a small whole-domain
  build with local synthetic coverage and terrain. Preserve offline startup,
  the synthetic label, and the documented sample. Exercise
  [`sample-preview`](../scripts/sample-preview.ts) seeding and restart with
  v5. Port routine client, preview and plugin fixtures to v5 while keeping
  dedicated compatibility fixtures.
- Route production build entry points through the whole-domain writer.
  Preserve CLI capacity admission before acquisition,
  cancellation, receipt partition validation, immutable uploads and exact
  input binding. Exercise full local publication and receipt-only hosted
  resume. The hosted downloader fetches the compact receipt artifact. Align
  the runbook with this behavior and test any future full-artifact resume
  through the workflow that downloads it.
  [Batch guide](../apps/batch/README.md) ·
  [Workflow runner](../scripts/publication-workflow.ts)
- Keep `pnpm refinement` and `pnpm refinement:evaluate` working. The latter
  replays saved v4 controls against multiple terrain variants. Keep the
  regional parser, pack reader, terrain preparation and station replay that
  these callers reach. Migrate the evaluator with report parity before
  replacing its control format. Keep regional science and whole-domain
  clearance in scope when tracing the shared terrain code.
  [Refinement guide](../apps/batch/src/refinement/README.md)

### Gate reader removal on retention and recoverability

1. Before merging a change that drops support, inventory every model in staging
   and production from the raw pointers. Check each unexpired retained
   entry's manifest, numeric pack layout, and provenance version, including
   builds eligible for rollback. Confirm a healthy compatible latest build
   for each model. Check expired latest entries too, since terrain preparation
   reads their manifests. Wait for incompatible retained entries to expire or
   migrate them with an explicit compatibility plan. Test terrain preparation
   with an expired legacy latest entry. Record representative pinned IDs for
   verification.
   [Operations](operations.md#roll-back-or-clean-up) ·
   [Deploy workflow](../.github/workflows/deploy.yml)
2. Account for in-flight shards and resumable artifacts. Resolve or rerun
   work that depends on removed plan/receipt formats or an earlier recipe
   identity. Verify the pointer state before retrying an ambiguous commit.
   Exercise resume, publish, post-commit checks, rollback and cleanup in
   staging and keep a deployable recovery revision.
   [Resume runbook](operations.md#resume-a-build)
3. Arrange staging verification before the production cutoff. Both deploy
   jobs run from `main`, and a push triggers production automatically. Gate
   the production job or land the change with the compatible reader still
   enabled in production. Exercise the cutoff in staging first. Verify
   latest and retained manifests, tiles and point/provenance routes for
   each model in staging and again after production deployment. Use a
   known covered tile to exercise the archive path. Exercise deployed and
   candidate clients across the deploy order and recovery revision. The
   deploy workflow probes every configured model before deploying Pages.
   [Smoke probe](../scripts/smoke-api.ts)
4. Remove unreachable v3/v4 serving branches, v1 plan and shard receipt
   paths, and legacy writer code after their respective gates pass. Preserve
   both v5 scalar layouts while writers or retained builds use them. Keep
   optional profiles, retained layer subsets, the stored-MSL marker, map vs.
   point frame selection, response version literals and existing URLs.
   Preserve pointer CAS, immutable expiry, ETags and budget admission.
   Regenerate OpenAPI and update the docs in the same change as the cutoff.
   [API publication](../apps/api/src/publication.ts) ·
   [Point contracts](../packages/contracts/src/point-products.ts)

## 5. Narrow imports and consolidate current ownership

- Measure actual preview startup and first-point chunks and the Windy
  production bundle. Record compressed transfer size and which inputs land
  in each bundle. Move model/source configuration behind a server-side
  entry point once browser callers are migrated. Use catalog metadata for
  model choices or a generated lightweight projection if startup needs
  synchronous defaults. Preserve default selection, offline mode and behavior
  when catalog requests fail. Update both apps and
  [`populateModelOptions`](../packages/client/src/client-view.ts). Windgram
  gust and CAPE labels currently look up the live registry. Prefer labels
  supported by the pinned build descriptors, with generic labels when those
  descriptors lack source semantics. Test an older pinned build.
  [Windgram view](../packages/windgram/src/windgram-view.ts)
- Keep runtime response validation at the client boundary. Route browser-only
  constants and helpers through narrow entry points with current callers.
  Separate pure geometry from schema validation where measurements justify it.
  Keep physical parameters with their calculation owners and preserve method
  descriptors in published manifests. Check production bundle inputs for
  `models.json`, Node built-ins and batch-only code, and set byte limits from
  the measured bundles. In a bundle check, keep the tested export reachable
  and use bytes attributed to emitted modules. Track pure sampler and
  validated client bundles separately. Preserve stylesheet loading and lazy
  Windgram startup. Enforce established import boundaries once callers are
  migrated, including package independence from apps and scripts.
  [Contracts](../packages/contracts/README.md) · [Client](../packages/client/README.md)
- Consolidate layer identity, interpolation, delivery and default surface
  assignment where declarations duplicate facts. Preserve ordered layer IDs
  and channel order, per-model method bindings, manifest-specific descriptors,
  and the distinction between native and fine lift. Use existing extension
  checks for grids, source fields, and capacity. [Layer definitions](../packages/contracts/src/layers.ts)
  · [Extension guide](extensions.md)
- After legacy retirement, split only responsibilities that still obscure the
  call path. Start with plan admission versus immutable receipt verification
  in [parallel builds](../apps/batch/src/parallel.ts), and preview URL/frame
  state versus MapLibre and popup lifecycle in [main.ts](../apps/preview/src/main.ts).
  Keep the existing raster controller and Windgram scene and panel seams.
  Preserve the Windy pane/overlay lifecycle and point updates while changing
  either app. [Raster overlay](../apps/preview/src/raster-overlay.ts) ·
  [Windgram entry point](../packages/windgram/src/index.ts)
- Use the existing [provider contract](../apps/batch/src/provider.ts).
  Share HTTP mechanics only where indexed and split GRIB have the same
  retry, cancellation and byte-accounting semantics. Likewise, point routes
  already share [bounded packed reads](../apps/api/src/packed-ranges.ts).
  Keep scalar interpolation and nearest-native profile selection in their
  respective routes. Require a current caller for new exports and use
  measurements to justify work in sampling, terrain reconstruction or I/O.
- Measure pack layout work in build admission and
  [serving-group assembly](../apps/batch/src/serving-groups.ts). Reuse admitted
  layouts for the same coverage and selected frames, and avoid replanning
  serving groups just to estimate their resources. Preserve pre-acquisition
  admission and account for buffers retained by both derive and raster pools.
  [Whole-domain admission](../apps/batch/src/whole-domain/capacity.ts)

## 6. Improve diagnosis with existing telemetry

- Extend the Worker request event with matched route, model/build when
  available, and stable problem code. Cover route errors, outer failures and
  early rejections. Keep request paths with coordinates or other raw input
  out of logs. Keep existing cache and R2 headers and `Server-Timing`.
  Verify the response contract and one log event per request when enabled.
  [Worker entry point](../apps/api/src/index.ts) ·
  [Serving budgets](serving-budgets.md)
- Correlate batch plan, shard, finalize and publish failures by model, build
  and workflow attempt using existing provider and performance counters.
  Preserve operator artifacts and their commit states, including
  `not-attempted`, `unconfirmed` and `committed`. Confirm that each failure
  points to the existing resume, cleanup, or rollback action.
  [Failure runbook](operations.md#check-a-failure)
- Add observed cache status, read counts and latency to the existing health
  probe where they help diagnose failures. Use controlled cold/warm load
  checks for performance comparisons. Record p95 latency, R2 reads/bytes and
  the measured Worker memory envelope at the documented request mix before
  changing serving limits.
  [Health monitor](../scripts/monitor-health.ts) · [Serving budgets](serving-budgets.md#runtime-and-load-checks)

## Landing the changes

Land parity coverage first, then the current v5 fixes and test-loop changes.
Land the v5 fixture and writer migration while retained readers are available.
Land reader removal after the rollout checks pass. Give browser import changes,
responsibility splits, and telemetry their own verification. Run `pnpm verify`
for each change and update the nearest README when a command or entry point
changes. Correct the terrain description in [deployments](status.md) to reflect
configured whole-domain builds. Run `pnpm docs:generate` when the CLI, layer,
method, model or OpenAPI inputs change and `pnpm docs:check` to verify references
and local links. [Reference generator](../scripts/generate-reference.ts) ·
[Roadmap](roadmap.md)

## Verification from implementation

On macOS arm64 with Node 22.23.4, pnpm 10.34.9, eight test workers, installed
dependencies and local Worker access, the `ab80afb` baseline ran in 25.70 s
and 25.97 s. The split unit project ran in 7.22–7.74 s and the integration
project in 16.25–16.47 s. Forks remain the default after the thread pool failed the
terrain and serving-group tests.

Identical prepared inputs on the baseline and updated serial writer produced
the same scalar and profile shard hashes, all 18 PMTiles hashes, and the same
frame and descriptor data across the three synthetic grid and pressure
coordinates. [Serial and shard parity](../apps/batch/src/native-build.integration.test.ts)
and [local Worker smoke](../scripts/sample-preview.integration.test.ts) run in
the integration gate.

With response caching bypassed, the scalar regression observes one binding
walk per cold surface and zero additional walks on warm calls. The profile
regression checks the scalar and profile bindings independently.
[Scalar tests](../apps/api/test/worker.test.ts) · [Profile tests](../apps/api/test/profile.test.ts)

The rollout uses fresh v5 forecasts for each configured model. Staging and
production probes and the deployed Worker memory measurement remain part of
that rollout. [Operations](operations.md#deploy-the-api-and-clients)
