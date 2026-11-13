# Numeric weather delivery plan

Publish bounded numeric weather chunks through the existing batch → R2 → API
pipeline, and render them in the current MapLibre viewer.

Proposal dated 2026-11-13, audited against `68c3b80`. The
[approved wind UI](wind-overlay-ui.md) is the build target. This PR records the
design; production contracts and forecast calculations remain unchanged.

## Recommendation

Start with **native wind columns for the visible area and one forecast time**,
plus separate numeric terrain and usable-lift surfaces. Once resident, the full
wind-height rail works without network requests. A bounded GPU pass creates the
selected 2D wind field; trails and barbs consume that field.

Use one small numeric delivery family for wind, cloud cover and precipitation.
Separate product payloads let the browser request only active layers. Keep the
decoder and field sampler independent of archive format and drawing style.

Prove this on real RRFS data around Woodstock before choosing the final chunk
size, overview resolution and renderer. Precomputed height slices are the
fallback if the volume sampler or mobile memory cost misses acceptance targets.

## Two implementation options

**A. Native columns + local height selection — preferred.** Publish per-time
spatial blocks containing height/U/V/status at available model levels, with
surface wind. Keep fine terrain and usable-lift MSL/status separately cacheable.
Retain the useful vertical range for resident blocks. Height changes update a
selection pass; ordinary animation samples only its resulting 2D field. This
preserves vertical shear and the fine local target height while avoiding a
separate derived global field for every slider stop. It requires a reference
sampler, projection handling, explicit CPU/GPU budgets and more client work.

**B. Precomputed 2D fields — simpler renderer integration.** Batch derives Surface,
ten AGL stops and Top of lift. Publish paired U/V/status numeric tiles in PMTiles;
load the selected height and prefetch neighbors. WeatherLayers can consume decoded
fields after projection-aware assembly. Cached selections are immediate; an
uncached height needs data. Fine terrain-following slices increase publication
work and storage substantially. Select this option if measured integration and
device costs outweigh A's warm-height benefit.

Zarr is a later packaging candidate if callers need broader multidimensional
access. [Zarrita](https://github.com/manzt/zarrita.js) reads Zarr v2/v3, including
[independently readable sharded chunks](https://zarr-specs.readthedocs.io/en/latest/v3/codecs/sharding-indexed/index.html).
[CarbonPlan zarr-layer](https://github.com/carbonplan/zarr-layer) adds MapLibre
scalar rendering and multiscales. Neither supplies physical-height wind sampling
or particle advection. Their chunks/shards are useful, but cloud cover and precipitation are
already ordinary 2D products. Keep this release's descriptor limited to the two
needed shapes: scalar grids and wind columns. PMTiles, binary packs and Zarr
describe storage; each still needs explicit units, masks and sampling rules.

## Existing data and next products

[NormalizedFrame](../packages/forecast/src/inputs.ts) already supplies 10 m wind,
upper-air U/V, level heights, model ground and missing masks. Winds are Earth-relative
in m/s. [Configured sources](../packages/contracts/config/models.json) currently
request 21 GFS, 25 RRFS, 30 ICON-EU and up to 40 av-wrf levels. Their existing
acquisition/rotation remains the source of truth. No additional upstream download
is required for the proposed wind product.

Use the existing [layer definitions](../packages/contracts/src/layers.ts) for
scalar meaning and availability:

- **Cloud cover:** all four models ingest total and low-cloud percentages as sample-only
  fields. Expose their numeric grids and validity. Keep source-specific low-cloud
  definitions and missingness. An 8-bit 0–100% encoding can be benchmarked against
  a declared error tolerance; clear sky is valid zero.
- **Precipitation:** `precip-rate` already represents trailing-interval mean
  liquid-water-equivalent precipitation in mm/h. Preserve interval start/end,
  dry zero, and unavailable status. Choose scalar precision against light-rain
  thresholds and heavy-precipitation range. A rain/snow phase display needs an
  explicit additional source or derivation.
- **Useful later callers:** 10 m gusts, thermal velocity, and surface LCL already
  have definitions. LCL retains its parcel meaning; presenting it as observed
  cloud base would change the product. Publish additional grids when their map
  control is implemented, following [extensions](extensions.md).

Palette and opacity belong to the renderer. Changing cloud or precipitation colors
should reuse numeric data. Existing painted lift/precipitation tiles stay available
through their current contracts during rollout.

## Sampling and precision

Surface is the source 10 m model-AGL vector. A numeric wind stop targets
`prepared local terrain MSL + selected AGL`. Top of lift targets that location's
numeric `usable-lift-msl`, requiring usable lift and supported wind.

For each map sample, determine one target MSL height, bracket it independently
in each contributing native column, interpolate paired U/V vertically, then
combine the same horizontally supported donors. Apply identical weights and
validity to both components. Derive speed and direction afterward. The existing
BL-top diagnostic uses another surface; share a narrow height-bracket helper
between the reference sampler and point inspection.

Keep unsupported valleys, above-profile heights and missing brackets unavailable.
The current lift clearance fallback supplies no valley wind extrapolation.
6000 m AGL will be unavailable in some columns. Preserve exact valid zero as calm.
Fixed-height wind remains available above the lift ceiling where supported.

The column codec candidate uses int16 U/V at **0.01 m/s**, int16 MSL heights at
**1 m**, and a status byte per level, plus paired surface wind/status. This is
7 bytes per level and 5 per surface cell before framing/compression. Validate
range, monotonic heights and rounding-collapsed brackets. Compare against original
Float32 columns under strong shear; height quantization adds error beyond U/V
quantization. Retain Float32 heights if that gate fails.

Emit column validity after native-ground/pressure admission. Base columns use
valid/unavailable/outside states; no-lift applies to the derived Top-of-lift field.
Keep Surface independently fetchable so its initial display needs only 10 m wind.

U/V quantization alone contributes at most about **0.026 km/h** vector error.
RG8 over ±64 m/s permits about **1.28 km/h**, enough to change integer labels and
calm/feather thresholds. Lossy images are unsuitable for numeric payloads.
[Lossless WebP](https://developers.google.com/speed/webp/docs/api) also needs
explicit preservation of transparent RGB. Typed binary avoids image color and
alpha conversion. Choose compression from actual byte/decode measurements.

Retain the existing numeric lift value and complete status/support byte for the
Top-of-lift target. Load terrain by immutable terrain identity so it survives
forecast changes. Record the current DEM datum and model-height convention in
provenance; use the same conventions as the existing lift calculation.

## API and publication changes

Add a **versioned numeric-product sidecar**, bound to the retained build:

```text
GET /v1/models/{model}/runs/{buildId}/data
GET /data/{model}/{buildId}/{product}/{frame}/{grid}/{lod}/{chunk}.bin
```

These are proposed routes. Product descriptors own codec version, channel units
and scales, grid/projection, coverage, level coordinate, time support, static
dependencies, chunk layout and verified archive/index references. Reuse existing
scalar descriptors. Keep per-product metadata nested and bounded; publish indexes
separately where required. Reject unsupported codec versions explicitly.

For option A, arrange one time/product's spatial blocks in immutable binary
shards with bounded offset/length indexes. Reuse the existing sparse block
geometry where measurements support it. Encode only wind/height/status;
existing full-profile files also contain thermodynamics and grouped times.
For option B, PMTiles supports custom tile data via its
[Unknown/Other type](https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md#tile-type-tt).
Both routes return a complete bounded chunk; Worker-to-R2 ranges remain internal.

Current [manifest v5](../packages/contracts/src/publication.ts) is strict and
couples scalar layers to surfaces/sample channels. Current
[PMTiles reads](../apps/api/src/pmtiles.ts) and
[browser raster transport](../packages/client/src/client-raster.ts) accept WebP.
Implement numeric validation and decoding explicitly, while sharing request
scheduling, cancellation, caching and lifecycle.

Extend the **internal stored pointer** with `mapData: {sha256, bytes}` per retained
build; derive `builds/{model}/{buildId}/map-data.json` canonically. Continue projecting the
existing public pointer shape and serving unchanged v5 manifests. Older builds
without the reference return an explicit product-unavailable result.

Publish chunks/indexes → verified sidecar → scalar manifest → one final pointer
compare-and-swap. The pointer binds all products atomically. Upgrade every pointer
reader/writer, retry path, rollback and cleanup before emitting new references;
an old parser can strip extra fields during a rewrite. Keep artifacts inside the
build prefix and preserve retained-build expiry/admission before cache lookup.

Cloud/precipitation additions reuse this publication lifecycle and scalar codec.
Each product has its own availability, time interval, resolution and precision.
Avoid multiplying cloud/rain payloads by wind height or fetching inactive products.

## Serving and browser performance

The current production `workers.dev` origin demonstrated caching in a two-request
probe: discovery changed from `X-Av-Response-Cache: miss` to `hit`, with R2 reads
falling from one to zero; a tile changed from `CF-Cache-Status: MISS` to `HIT`.
The [evidence](assets/wind-overlay/capacity.json) preserves selected response headers.
This conflicts with the older [R2 example warning](https://developers.cloudflare.com/r2/examples/cache-api/).
The [current runtime documentation](https://developers.cloudflare.com/workers/runtime-apis/cache/)
distinguishes Cache API from outer CDN caching. Deployed behavior differs from
this checkout; inspect its revision before changing cache architecture.

A custom API hostname makes deployment ownership explicit. Verify new-route
cache hits, cross-region behavior and expiry on the chosen origin. On an outer
CDN hit, cached R2/Server-Timing headers describe the original fill. Keep those
separate from fresh Worker counters; two local hits establish no throughput claim.

Keep chunk URLs immutable and expiry-bounded. Reuse current
[serving budgets](serving-budgets.md), including four active browser requests,
two prefetch slots and the shared compressed cache. Prioritize current viewport
and time; cancel superseded work. Load a coarse valid overview before native
detail at wide extents. Coarse products need model-aware reduction and mask/shear
validation; averaging level indices across varying heights changes meaning.

Track compressed cache, decoded CPU arrays, GPU textures and temporary uploads
separately. A seven-byte column sample can occupy substantially more GPU memory.
Retain current time first; prefetch another time only within admitted capacity.
Use generation IDs and atomic field swaps so slow old responses cannot replace
the selected forecast. Reset/fade trails on a field change and release resources
on eviction, hidden wind and context loss according to the chosen cache policy.

For A, run vertical selection only when the view's data, target height or time
changes. Cap its geographic field resolution independently of particle density.
Warm height changes update uniforms and the selected field, with no full-volume
upload. CPU hover/barb sampling uses the same reference rules without synchronous
GPU readback. Barbs and particles must agree at the same location.

The zero-request condition requires the current model/build/time, visible columns
and halos, vertical brackets, masks and terrain/lift companions to be resident.
Eviction or a new viewport/time can require loading. One complete RRFS frame
expanded to Float32 arrays/status would exceed 500 MiB; retain viewport blocks.

Use a small lazy-loaded MapLibre custom layer for the GPU selection/particle path.
The [custom-layer API](https://maplibre.org/maplibre-gl-js/docs/API/interfaces/CustomLayerInterface/)
provides `prerender` and `render`. Reuse a maintained particle implementation after
license and lifecycle review. Keep the field interface independent of the engine.
Exact XC geometry still needs controlled assets/sampling; standard barbs alone
do not establish the accepted visual match.

[WeatherLayers](https://docs.weatherlayers.com/weatherlayers-gl/layers/particle-layer)
is the leading off-the-shelf trial for B: connected white lines and configurable
history. Its [data interface](https://docs.weatherlayers.com/weatherlayers-gl/layers/data-properties)
accepts CPU Uint8/Float32 arrays; a GPU-produced altitude texture needs an adapter
or extension. Its documented field projection is regular longitude/latitude, so
WebMercator/native tiles need correct reprojection. Mapbox `raster-particle` is a
separate Mapbox feature and is absent from the current MapLibre layer registry.

[Sakitam maplibre-wind](https://github.com/sakitam-fdd/wind-layer/tree/9e1446890306a7e423de71ec4c6b70bba1db33df/packages/maplibre-gl)
is another 2D candidate with tiled particles, scalar rendering and timeline sources.
Its current camera adapter uses private MapLibre fields and develops against an
older version; verify compatibility with this viewer before adopting it. EXIF
Layer's current tapered point trails conflict with the approved appearance.

Build the standalone viewer first. Share numeric loading/sampling with the Windy
plugin, then implement its separate host adapter. Preserve the plugin's existing
bundle gate; measure dependency cost before adding a rendering framework.

## Capacity evidence and decision gates

[Capacity evidence](assets/wind-overlay/capacity.json) records input hashes,
coverage counts, formulas and the pinned RRFS build metrics. These are raw logical
payload calculations; compressed sizes and incremental runtime need measurement.

Copying the current RRFS raster pyramid for all 12 choices adds **9.28 million
tiles**, exceeding the whole-build five-million cap. Even 64-sample tiles through
z8 add **13.28 GiB** raw across 40 frames and 12 choices. At Woodstock that is
about 1.90 km sample spacing; fine terrain is 1.5 km. z9 improves spacing but
raises the addition to **49.20 GiB**, exceeding the 64 GiB logical numeric budget
when combined with the existing **29.02 GiB**.

Native columns use the existing native resolution and preserve finer target
selection with separate terrain/lift data. All-frame wind-column candidates are
about **1.66 GiB GFS, 4.23 GiB ICON-EU, 10.72 GiB RRFS, 0.49 GiB av-wrf**, before
indexes, overviews and numeric target-surface delivery. Compression lowers
transfer/storage bytes; logical admission still counts decoded data.

The pinned RRFS build reports **61.38 minutes** and **1.977 GiB peak process RSS**.
Its admitted working set is only about 102 MiB below the 2 GiB limit. Stream
bounded chunks while each normalized frame is resident; account for every new
buffer and artifact. Native columns avoid deriving twelve complete fine fields.

Implement in four reviewable stages within this feature branch:

1. **Real-data spike:** RRFS Woodstock, mountain/valley boundaries and strong
   shear; then one model-level source. Compare original CPU reference, decoded
   CPU and GPU samples. Exercise all approved AGL stops, Surface and Top of lift.
   Benchmark columns against selected-height tiles on desktop and an actual phone.
2. **Numeric publication:** bounded codecs, sidecar, pointer migration,
   capacity accounting, verification, rollback and retained-build tests. Add the
   deployed-origin cache check. Publish wind and required numeric target surfaces.
3. **Viewer:** shared transport/worker, bounded GPU field, all three approved
   styles and compact controls. Run cancellation, seam/mask, context-loss,
   expiry and long pan/time tests. Gate native detail/overview on accuracy.
4. **Scalar rollout:** total/low cloud and numeric precipitation, with independent
   availability and palettes. Demonstrate a palette edit that downloads no new
   data. Add further scalar products only with their current UI caller.

Proposed acceptance targets: resident height selection in one or two display
frames, zero HTTP requests and full-volume uploads during warm scrubbing, smooth
60 fps desktop / stable 30 fps mobile, and bounded memory after repeated panning.
Record cold bytes, first-valid-field latency, decode/upload time, warm selection
p95, animation frame-time p95 and peak CPU/GPU memory separately. These targets
require measurement; visual smoothness alone cannot establish field accuracy.
