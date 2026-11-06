# Phase 2 client and UI cutover

Connect the preview and Windy clients to one pinned AV build, including the full
native point horizon and the map prefix.

```sh
pnpm test
pnpm verify
```

Phase 1 owns wire schemas, profile coordinates, fields and serving limits.
[Architecture](architecture.md) owns the workspace map. Keep each milestone
independently deployable.

## Milestone 2A: Shared client and raster delivery

Extend [`ApiClient`](../packages/contracts/src/client-api.ts) with multi-point
samples and point profiles. Reuse its injected fetch, deadline, retry,
cancellation, expiry and response-validation paths. Validate each response
against the pinned model, build, source, expiry, requested coordinates, frames
and fields. Keep legacy version-3/version-4/version-5 readers covered.

Expose optional rendered tile templates in
[`PinnedBuild`](../packages/contracts/src/client-types.ts). Filter server
latest templates, tile routes, picker choices and prefetch plans by the layer's
delivery descriptor. Existing manifests retain their tile-backed defaults.
Use one descriptor helper for this decision.

Pin the expanded latest response once when opening a dataset or switching a
model. Tiles, point cards, tables, profiles and soundings share that build.
Refreshing creates a new dataset; expiry clears the old display and pending
work. Abort superseded selections and prevent late responses from changing it.

Multi-point requests select explicit frames and fields. Preserve input order
with point identities while canonicalizing cache keys. Coordinate rounding is
an explicit client choice reflected in returned coordinates. Bound points,
values, response bytes and combined R2 ranges using the Phase 1 planner;
client chunking respects those limits. Enforce request-wide read concurrency.
V5 point requests default to the first frame; full timelines use bounded pages.
See [serving budgets](serving-budgets.md).

Review delivery filtering, compatibility, cancellation and resource admission
before proceeding.

## Milestone 2B: Preview and Windy point views

Keep the preview's tested
[`RasterOverlay`](../apps/preview/src/raster-overlay.ts) staging and last-good
frame behavior. Verify quick keyboard scrubbing, failed replacements, expiry
and model switches. Change its mechanism only with measured improvement and
preserved behavior.

Keep the lean 18 native and two fine scalar channels. Profiles retain every
covered native cell and nullable P/H/T slot. Compute mixed-layer LCL, effective cloud limit and BL top
wind on demand from each profile and its emitted thermal top; use shared pure
helpers and preserve the model-PBL fallback for stable columns. These values
remain available through the profile API without additional scalar channels.

On click, fetch the configured map selection containing lift MSL/AGL,
precipitation, thermal velocity, LCL, 10 m and boundary-layer wind components,
and cloud cover. Render the selected frame summary and a keyboard-accessible
chart: known terrain floor, usable-lift bar and LCL marker. Load the selected
hour first, then the remaining bounded pages; reuse completed frames. Mark
elapsed gaps between adjacent published times and identify incomplete series
after failed pages. Legacy readers retain their 24-hour initial point view.
Unknown floors use ceiling markers and an explicit unknown label. Selecting a chart frame
updates the map from the cached series. Offer the full native point horizon
through bounded frame pages. Keep point time and displayed map time explicit
when a selected native frame falls beyond the map prefix. Preserve missing
values and diagnostic support in labels; absence of cloud flags alone cannot
establish a blue regime.

Use the shared soaring view function for scalar wind and sink-threshold
calculations. Add terse labels for cumulus, overdevelopment and cloud capping.
Format displayed heights and velocities in the chosen units.

Terrain comes from an explicit fine-surface terrain value when available.
Current public no-lift MSL samples are null. A lift-height difference is usable
only for matching, valid, uninterpolated fine values. Mixed no-lift donors use
different MSL and AGL interpolation weights. Show unknown terrain otherwise.
Keep native model elevation and fine terrain distinct.

Windy's current pane owns model and opacity controls. Add its point selection,
chart and listeners with explicit pane/overlay lifecycle ownership and cleanup;
follow the host timeline without mixing builds.

If approximate tile hover is implemented, use already loaded tile data and a
bounded cache. Quantized palette inversion must represent ambiguity and
transparent pixels. Exact readouts use point samples. Measure hover CPU and
memory before enabling it.

Review UX, accessibility, forecast meaning, render churn and retained memory.
Run client tests and browser checks before proceeding.

## Milestone 2C: Production validation

Run root checks and browser tests for point selection, units, keyboard controls,
map replacement failures, paging and cancellation. Verify full native point
horizons and explicit absence of fine lift beyond the map prefix. Point times
outside that prefix preserve the displayed map and identify its separate time.

Measure 32-point batches and profile reads with cold and warm caches against the
serving limits. Verify old retained URLs, nighttime observations, adjacent native
cells, response digests, conditional requests and sample-only raster rejection.
Record actual full-build RSS and elapsed time before declaring each model ready.

Review the PR again after checks pass, merge, then verify production endpoints
and rendered views. Correct failures and repeat the affected checks.

Historical validation (2026-11-06): production preview checks passed for the
then-published GFS 384-hour and ICON-EU/RRFS 48-hour horizons at 320 px and
393 px, including bounded paging, cache reuse, units and retained map captions.
All native fields were valid
across 48 ICON frames near the approximate screenshot location. See the
[production evidence](phase3-models-and-sunlight-handoff.md#completion).
Current output windows come from
[forecast-windows.ts](../packages/contracts/src/forecast-windows.ts); each new
publication requires the production checks above. Windy controller/bundle checks
pass; its production developer loader requires
an authenticated host session.

## Deferred consumer cutover

Windgrams adapters, offline snapshots, activation and retirement of its duplicated
weather acquisitions are deferred. Its terrain and observation producers remain
unchanged. The separate [consumer PR](https://github.com/jdorrance/windgrams/pull/15)
stays draft for that later work.
