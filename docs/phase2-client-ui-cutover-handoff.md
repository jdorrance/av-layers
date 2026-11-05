# Phase 2 client and UI cutover

Connect the map clients and Windgrams to one pinned AV build, preserve existing
forecast display contracts, then retire the duplicated GFS, RRFS and ICON-EU
builders after production parity.

```sh
pnpm test
pnpm verify
```

Phase 1 owns wire schemas, profile coordinates, fields and serving limits.
[Architecture](architecture.md) owns the workspace map. Windgrams lives in the
[sibling repository](../../windgrams/README.md); its changes need a coordinated
PR and its own checks. Keep each milestone independently deployable.

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
covered native cell. Compute mixed-layer LCL, effective cloud limit and BL top
wind on demand from each profile and its emitted thermal top; use shared pure
helpers and preserve the model-PBL fallback for stable columns. These values
remain available to Windgrams without additional scalar channels.

On click, fetch a bounded diurnal selection containing lift MSL/AGL,
precipitation, thermal velocity, LCL, 10 m and boundary-layer wind components,
and cloud cover. Render the selected frame summary and a keyboard-accessible
chart: terrain floor, usable-lift bar and LCL marker. Selecting a chart frame
updates the map from the cached series. Preserve missing values and diagnostic
support in labels; absence of cloud flags alone cannot establish a blue regime.

Use the shared soaring view function for scalar wind and sink-threshold
calculations. Add terse labels for cumulus, overdevelopment and cloud capping.
Format displayed altitudes in the chosen units.

Terrain comes from an explicit fine-surface terrain value when available.
Current public no-lift MSL samples are null. A lift-height difference is usable
only for matching, valid, uninterpolated fine values. Mixed no-lift donors use
different MSL and AGL interpolation weights. Show unknown terrain otherwise.
Keep native model elevation, fine terrain and launch elevation distinct.

Windy's current pane owns model and opacity controls. Add its point selection,
chart and listeners with explicit pane/overlay lifecycle ownership and cleanup;
follow the host timeline without mixing builds.

If approximate tile hover is implemented, use already loaded tile data and a
bounded cache. Quantized palette inversion must represent ambiguity and
transparent pixels. Exact readouts use point samples. Measure hover CPU and
memory before enabling it.

Review UX, accessibility, forecast meaning, render churn and retained memory.
Run client tests and browser checks before proceeding.

## Milestone 2C: Windgrams profile and regional adapters

Add one transport adapter in
[`@windgrams/data-client`](../../windgrams/packages/data-client/README.md).
Keep windgram and Skew-T renderers on their existing published profile types.
Resolve launch coordinates through the site catalogue and route configured AV
models through a pinned latest response and profile endpoint.

Map `cycle` to run reference time and use the manifest generation timestamp for
capture time. Preserve surface field units, precipitation interval meaning,
nulls, source availability, vertical resolution and diagnostic support. Retain
native model elevation independently of launch elevation and fine terrain.
Compute shared derived views once. Validate serialized output with
[`parsePublishedProfileJson`](../../windgrams/packages/contracts/src/published-lift.ts).

The current
[`RegionalDataset`](../../windgrams/packages/data-client/src/dataset-types.ts)
exposes native-cell grids, hourly arrays and cell-index profiles. Its sampling
selects one cell. AV sampling interpolates surfaces. Define the smallest live
regional interface required by current callers, including sampling semantics,
selected coordinates, time and field status, before adapting those callers.
Preserve existing saved-dataset readers.

Render lift and precipitation through AV tile templates. Populate launch
comparison tables and route cross-sections with bounded multi-point requests,
coalesced by build/frame/field selection. Load a clicked profile on demand for
the existing windgram and sounding views. Expose unavailable fields and gaps.
Keep outstanding requests and cached profiles bounded.

Verify Blanchard and Aparan adapter fixtures, model switching, height inspection,
sounding scrubbing, launch tables, routes and missing coverage in browser tests.
Review contract parity and sampling semantics independently.

## Milestone 2D: Offline parity and production cutover

Windgrams snapshots verify exact file bytes against an inventory of sizes and
SHA-256 digests. Current AV sample ETags identify queries. Add a versioned AV
snapshot inventory and body-digest contract, retaining build identity and scope,
before adapting offline storage. Preserve atomic saves, resume, cancellation,
quota handling and reopening without network access.

Run the Windgrams root checks in its README, including consumer, browser and
build checks. Measure 32-point launch/route queries and profile reads with cold
and warm caches against the existing serving limits. Keep configured limits
until measurements justify a change.

Deploy both adapters with the old builders available. Verify production launch
windgrams, soundings, maps, tables, routes and offline reopening against pinned
builds; record model, cycle, endpoint and parity evidence.

Then retire the matching jobs in
[`refresh-rrfs.yml`](../../windgrams/.github/workflows/refresh-rrfs.yml),
[`refresh-dwd.yml`](../../windgrams/.github/workflows/refresh-dwd.yml) and the GFS
portion of
[`refresh-noaa-cloud.yml`](../../windgrams/.github/workflows/refresh-noaa-cloud.yml).
Update Pages artifact collection and provider health together. Retain the other
model and observation workflows; this cutover serves GFS, ICON-EU and RRFS.
Document and exercise rollback before deleting duplicated acquisition code.

Review the PRs again after checks pass, merge coordinated changes, and verify
production endpoints and rendered views before declaring the phase complete.
