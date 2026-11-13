# Numeric weather delivery plan

Publish bounded numeric weather chunks through the existing batch → R2 → API
pipeline, and render them in the current MapLibre viewer.

Proposal dated 2026-11-13, adversarially reviewed against `b49a3bd`. The
[approved wind UI](wind-overlay-ui.md) is the build target. This PR records the
design; production contracts and forecast calculations remain unchanged.
The [review and executable evidence](weather-data-review.md) track corrected
failure cases and the performance gates required before release.

## Recommendation

Trial **native wind columns for the visible area and one forecast time**,
plus separate numeric terrain and usable-lift surfaces. Once resident, the full
wind-height rail works without network requests. A bounded GPU pass creates the
selected 2D wind field; trails and barbs consume that field.

Use one small numeric delivery family for wind, cloud cover and precipitation.
Separate product payloads let the browser request only active layers. Keep the
decoder and field sampler independent of archive format and drawing style.

Keep this choice provisional. Compare it with grouped precomputed fields on real
RRFS data around Woodstock before choosing the representation, chunk size,
overview resolution and renderer. Include cold entry, time changes, height
sweeps and uncached pans under the same accuracy, coverage and resource limits.

## Two implementation options

**A. Native columns + local height selection — working hypothesis.** Publish per-time
spatial blocks containing height/U/V/status at available model levels, with
surface wind. Keep fine terrain and usable-lift MSL/status separately cacheable.
Retain the useful vertical range for resident blocks. Height changes update a
selection pass; ordinary animation samples only its resulting 2D field. This
preserves vertical shear and the fine local target height while avoiding a
separate derived global field for every slider stop. It requires a reference
sampler, projection handling, explicit CPU/GPU budgets and more client work.

**B. Precomputed 2D fields — simpler renderer integration.** Batch derives Surface,
ten AGL stops and Top of lift. Publish paired U/V/status in grouped spatial binary
chunks on the existing fine grid, with the same bounds/index policy as A. PMTiles
is an optional packaging choice. Load the selected height and prefetch neighbors.
WeatherLayers can consume decoded fields after projection-aware assembly. Cached
selections are immediate; an uncached height needs data. This trades publication
work for smaller selected-time/height payloads. Measure the complete interaction
trace before choosing A or B; the best storage tradeoff varies by model.

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
in m/s. [Configured sources](../packages/contracts/config/models.json) include
GFS, RRFS, ICON-EU, av-wrf and the two registered Armenia WRF products. The first
four request 21, 25, 30 and up to 40 levels respectively. Their existing
acquisition/rotation remains the source of truth. No additional upstream download
is required for the proposed wind product.

Use the existing [layer definitions](../packages/contracts/src/layers.ts) for
scalar meaning and availability:

- **Cloud cover:** the configured models ingest total and low-cloud percentages as sample-only
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

Version the wind sampling method. The first method uses bilinear interpolation
when every positive-weight donor supports the target; otherwise it chooses the
geometric-nearest donor for both components, using weight then row/column tie
ordering from [sampleCells](../packages/forecast/src/sampler.ts). That donor can
remain unavailable. Preserve source-level positions and gaps: accept an exact
valid level, or interpolate between two consecutive source levels that are both
valid and bracket the target; never skip masked rows. Surface is a separate mode;
this version adds no synthetic 10 m lower interpolation anchor.

Bind Top-of-lift target sampling to the build's `useStoredMslNoLift` method and
the scalar sampler's complete status/support rules. Finite no-lift terrain values
remain no-lift. With stored MSL interpolation, equal-weight values
`[valid 2000, no-lift 500, no-lift 500, no-lift 500]` yield no target; two valid
2000 m donors and two no-lift 500 m donors yield a valid 1250 m target. Preserve
the majority threshold, ties and missing-donor behavior on CPU and GPU.

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
shards. Separate storage blocks from browser chunks: group neighboring blocks
under fixed spatial chunk IDs, preserving static terrain cache reuse. Independently
compress each chunk; retain a range-addressable shard. Record encoded and exact
decoded lengths, codec, offset and content digest. Serve the compressed bytes as
octet-stream with no HTTP content encoding, so the encoded cache counts actual
retained bytes; a worker performs bounded decompression. Pilot chunks cap decoded
data at 256 KiB and encoded data at 256 KiB plus a 4 KiB header. Use raw encoding
when compression expands a chunk. Enforce both limits before allocating.

Keep the root descriptor small. Use fixed spatial pages of at most 1024 binary
index entries, at most 64 KiB per page, partitioned by product/frame/grid/LOD.
The root names page layout and verified page roots; fetch only intersecting pages.
Count page requests, bytes and dependency depth in cold-load admission. RRFS has
5624 native storage blocks; its complete 40-frame index at 24 bytes per record
would already occupy 5.15 MiB. A flat JSON block list exceeds existing limits.

Publication verifies complete immutable shards. Serving validates bounded index
pages, object identity/length and the requested range. Verify a requested chunk's
digest where required; a cold read must never fetch/hash an entire shard.
Reuse [packed range validation](../apps/api/src/packed-ranges.ts) and
[immutable upload verification](../apps/batch/src/immutable-upload.ts).
Encode only wind/height/status;
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
an old parser can strip extra fields during a rewrite. Keep forecast artifacts
inside the build prefix; retain shared terrain/coverage under their immutable
identities. Admit retained builds on descriptor reads and numeric cache misses.
Successful validated numeric responses explicitly opt into the existing Workers
Cache front cache. Use canonical build/product/codec/grid/frame/LOD/chunk identity,
deployment isolation, TTL capped at build expiry and mandatory revalidation.
Errors opt out. Retain published builds and numeric references through their
declared expiry. Rollback changes the latest selection while preserving unexpired
builds; cleanup and pointer migration preserve their artifacts and references.
This release provides expiry-based removal. Early pointer deletion cannot revoke
immutable browser copies, stale-pointer admissions or in-flight cache fills.

Cloud/precipitation additions reuse this publication lifecycle and scalar codec.
Each product has its own availability, time interval, resolution and precision.
Avoid multiplying cloud/rain payloads by wind height or fetching inactive products.

## Serving and browser performance

Current [API routing](../apps/api/src/index.ts) enables the front cache for tiles
and explicitly opts other routes out. Add the numeric success route to that policy;
the filename suffix supplies no cache eligibility. Keep mutable discovery and
errors under their current policy. The [recorded probe](assets/wind-overlay/capacity.json)
observed discovery and tile hits on `workers.dev`, consistent with current main.
Verify new-route cache hits, cross-region behavior and expiry on the chosen origin.
Outer CDN hits skip Worker admission; cached R2/Server-Timing headers describe the
original fill. Two local hits establish no throughput claim.

Keep chunk URLs immutable and expiry-bounded. The existing
[scheduler and serving budgets](serving-budgets.md) own concurrency, queue size,
encoded-cache capacity and speculation limits. Extend that scheduler for numeric
responses; separate raster and numeric schedulers would multiply demand. Share
the overview speculation cutoff across enabled products and stop background
admission while foreground work waits.

Admit a complete view before dispatch. Count HTTP chunks and index/companion
requests as well as bytes; issue work incrementally instead of queueing the
entire native viewport. The [footprint audit](assets/wind-overlay/review-evidence.json)
finds 96 ungrouped requests for a 1200 × 600 Woodstock z9 envelope. Illustrative
fixed grouping reduces that to six, while increasing raw payload from 0.71 to
0.97 MiB. At z8 even grouped data needs 24 requests / 3.44 MiB, before metadata.

Pilot admission targets: at most 16 numeric data chunks and 2 MiB encoded bytes
for a native view, with index pages charged separately; first-valid overview
payload at most 256 KiB across four data chunks. These are experiment limits,
to be validated before becoming constants. Select a coarser supported LOD when
the view exceeds either limit. Coarse products need model-aware reduction and
mask/shear validation; averaging level indices across varying heights changes
meaning. Use a fixed physical-height overview lattice with explicit coverage,
brackets and error bounds if native-level reduction cannot preserve the method.
Each reduced vertical interval must retain support for every original bracket
it spans; valid endpoints alone cannot bridge a missing source level.

If no LOD meets accuracy, useful-coverage and resource gates, hide wind and show
`Zoom in for wind` through the wind control. Use `Wind unavailable` for unsupported
products/heights. Retain the selection and retry only when view, data or height
changes. An unavailable overlay never counts as a fast successful display.

One admission owner accounts for existing raster preparation, decoded arrays,
numeric terrain/lift, GPU textures, particle state, trail buffers and staging.
Keep the current encoded-cache ceiling and existing 96 MiB forecast resource
estimate; count new wind allocations inside it. Reserve active and replacement
fields before loading. Start with at most 16 MiB of wind resources and 8 MiB
temporary decode/upload storage inside that shared estimate. Evict speculative
times and prepared rasters first, then lower overview/field/trail resolution.
Charge old and new fields together during a swap. The existing raster-only
replacement exception grants no extra wind allowance. Cap trail pixel dimensions
independently of DPR and include both ping-pong buffers. Driver and basemap costs
require separate whole-page measurements.

Retain current time first; prefetch another time only within admitted capacity.
Use generation IDs and atomic field swaps so slow old responses cannot replace
the selected forecast. Reset/fade trails on a field change and release resources
on eviction, hidden wind and context loss according to the chosen cache policy.
New visible work cancels obsolete queued requests and aborts dispensable reads
and decode/selection tasks. Late completions cannot upload or present. Foreground
field work takes priority over neighboring heights/times and speculative overviews.

Coordinate presentation by model/build/frame/height/dependency hashes/LOD. The
existing timeline may display a new lift overview before wind is ready. Show
matching-time coarse wind if resident; otherwise hide stale wind and expose a
compact loading state in its control. Never relabel the previous wind field.
Apply the same rule to cloud/precipitation. Commit all chunks of a selected field
together and clear its old trails. Test distant time jumps and the full enabled
layer stack, including sparse frame times and unavailable products.

For A, run vertical selection only when the view's data, target height or time
changes. Cap its geographic field resolution independently of particle density.
Warm height changes update uniforms and the selected field, with no full-volume
upload. Declare the selected 2D lattice, projection, node origin, masks and
interpolation as the display authority. GPU barbs and particles sample that
field and its support/reconstruction policy. CPU probes reproduce that policy off the
main thread, without GPU readback. Direct native-column diagnostics stay labelled
as such. Validate field approximation against direct sampling separately: the
[counterexample](assets/wind-overlay/review-evidence.json) produces a 10.8 km/h
difference solely from resampling across terrain and shear. Treat missing cells
and no-lift boundaries explicitly; ordinary filtering of packed integers or
invalid texels cannot define the method. Preserve reference availability between
field nodes, including small no-lift islands and coverage gaps. Carry support
and reconstruction information or use a bounded validated sampling path for
ambiguous cells. Keep nearest-donor discontinuities explicit: continuous blending
across a donor change retains about 18 km/h error in the audit even after 100×
refinement. Test every LOD against the original reference at off-node locations;
CPU/GPU agreement alone cannot certify the approximation.

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

If GPU selection is unsupported while MapLibre works, a bounded worker CPU
sampler builds the same selected field/support representation for static Canvas2D
barbs. Disable particle animation in that fallback and apply the same admission
and accuracy gates. Whole-map WebGL context loss hides wind, preserves controls
and resumes after restoration; a drawing-style change cannot restore that context.

[WeatherLayers](https://docs.weatherlayers.com/weatherlayers-gl/layers/particle-layer)
is the leading off-the-shelf trial for B: connected white lines and configurable
history. Its [data interface](https://docs.weatherlayers.com/weatherlayers-gl/layers/data-properties)
accepts CPU Uint8/Float32 arrays; a GPU-produced altitude texture needs an adapter
or extension. Its documented field projection is regular longitude/latitude, so
WebMercator/native tiles need correct reprojection. Mapbox `raster-particle` is a
separate Mapbox feature and is absent from the
[current MapLibre registry](https://github.com/maplibre/maplibre-gl-js/blob/v6.16.0/src/style/create_style_layer.ts).

[Sakitam maplibre-wind](https://github.com/sakitam-fdd/wind-layer/tree/9e1446890306a7e423de71ec4c6b70bba1db33df/packages/maplibre-gl)
is another 2D candidate with tiled particles, scalar rendering and timeline sources.
Its current camera adapter uses private MapLibre fields and develops against an
older version; verify compatibility with this viewer before adopting it. EXIF
Layer's current tapered point trails conflict with the approved appearance.

Build the standalone viewer first. Share numeric loading/sampling with the Windy
plugin, then implement its separate host adapter. Preserve the plugin's existing
bundle gate. The preview's startup and combined lazy gates already cover the
Windgram and current code; lazy loading creates no spare allowance. Measure
incremental gzip bytes and interaction-ready latency for the decoder and renderer.
Any allowance change requires those measurements and an explicit budget update.

The approved standalone basemap is Google Terrain. Keep MapLibre and use the
official [terrain tile API](https://developers.google.com/maps/documentation/tile/terrain)
with `mapType: terrain` and `layerRoadmap`, a restricted Maps Platform key, and
session reuse through its returned expiry. Honor returned tile dimensions and
viewport attribution. Provider imagery follows its
[cache and attribution policy](https://developers.google.com/maps/documentation/tile/policies);
the immutable forecast cache continues to own our weather artifacts. Measure
session setup, first basemap display and combined tile traffic in startup tests.
Provider configuration is required before replacing the reference basemap.

The compact km/mi control owns the shared display-unit preference. Update the
map and Windgram formatters together; current wind m/s/kt conventions become the
approved km/h/mph pair. SI fields, field identity, physical height stops and
particle motion remain unchanged. Unit, opacity and display-style changes reuse
resident fields. The [UI target](wind-overlay-ui.md#map-controls-and-defaults)
owns the quantity mappings and default/URL precedence.

## Capacity evidence and decision gates

[Original capacity evidence](assets/wind-overlay/capacity.json) records the four-model
baseline and pinned RRFS build. The [current audit](assets/wind-overlay/review-evidence.json)
recomputes all six configured models, cadence, retention and viewport costs.
These are raw logical payload calculations; compressed sizes and incremental
runtime need measurement. Fair grouped-chunk A/B all-frame wind costs are
**1.66/39.71 GiB GFS**, **4.23/26.11 GiB ICON-EU**, **10.72/14.02 GiB RRFS**,
and **0.489/0.103 GiB av-wrf**. The two Armenia WRF products are **0.069/0.015 GiB**
and **0.127/0.027 GiB**. A includes columns; B includes all twelve fine-grid choices.
Both exclude indexes, overviews and compression; A also needs its target surfaces.

RRFS B plus existing numeric data totals **43.04 GiB** before those extras,
within the 64 GiB logical ceiling. One selected RRFS fine-grid slice carries
about **one ninth** of the corresponding column wind bytes. Across all six
cadences B totals **319.50 GiB/day raw**, versus A's **67.13 GiB/day**. Compare
measured traffic, publication work and retained storage at equal quality.

Raster-pyramid packaging changes the work and resolution tradeoff. Copying the
current RRFS raster pyramid for all 12 choices adds **9.28 million
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

The two registered Armenia WRF products add about 0.069 and 0.127 GiB per run.
All six configured cadences produce **67.13 GiB/day**, or **469.92 GiB over seven
days**, of raw additional columns before indexes, overviews and companion delivery.
Admit peak local disk, simultaneous encoders, upload/verification operations,
publication time and retained compressed bytes. Reuse immutable terrain and
existing numeric lift owners. Compressed capacity and schedule headroom remain
release gates requiring a full representative build.

The pinned RRFS build reports **61.38 minutes** and **1.977 GiB peak process RSS**.
Its **2,040,638,557-byte planned working set** is about 102 MiB below its separate
2 GiB admission limit; the observed RSS limit is 4 GiB. Stream
bounded chunks while each normalized frame is resident; account for every new
buffer and artifact. Native columns avoid deriving twelve complete fine fields.

Implement in four reviewable stages within this feature branch:

1. **Real-data spike:** RRFS Woodstock, mountain/valley boundaries and strong
   shear; then one model-level source. Compare original CPU reference, decoded
   CPU and GPU samples. Exercise all approved AGL stops, Surface and Top of lift.
   Benchmark columns against equivalently grouped fine-grid fields on desktop
   and an actual phone. Run the identical cold/time/height/pan trace, record
   peak JS/native/GPU allocations and quality/coverage, and apply the
   [pre-publication decision gate](weather-data-review.md#before-stage-2).
2. **Numeric publication:** bounded codecs, sidecar, pointer migration,
   capacity accounting, verification, rollback and retained-build tests. Add the
   deployed-origin cache check. Test old/new pointer readers, fence old writers,
   and exercise forced rollback, CAS retries and cleanup without losing retained
   numeric references. Missing/corrupt referenced sidecars block publication or rollback.
   Old builds hide unavailable wind while existing painted layers remain usable.
   Publish wind and required numeric target surfaces.
3. **Viewer:** shared transport/worker, bounded GPU field, all three approved
   styles and compact controls. Run cancellation, seam/mask, context-loss,
   expiry and long pan/time tests. Gate native detail/overview on accuracy.
4. **Scalar rollout:** total/low cloud and numeric precipitation, with independent
   availability and palettes, after the wind gates pass. Demonstrate a palette edit that downloads no new
   data. Add further scalar products only with their current UI caller.

Benchmark gates are owned by the [adversarial review](weather-data-review.md#release-gates).
The existing [timeline benchmark](preview-performance.md) supplies the baseline
and requested-versus-displayed correctness harness. Extend it with real numeric
fields and full-stack readiness; keep its current zero-superseded-frame guarantee.
