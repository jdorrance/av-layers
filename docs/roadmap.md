# Roadmap

See [deployments](status.md) for live applications, [science](science.md) for
current calculations, and [extensions](extensions.md) for adding models and
layers.

## Publication tiers and fast client delivery

New physics outputs and interactive queries map to three storage tiers and a
block-cached delivery path within [`format.ts`](../packages/contracts/src/format.ts)
and [serving budgets](serving-budgets.md):

1. **Tier 1 — Spare support bits in `samples.bin` (0 extra bytes):** each 5-byte
   sample record (`Float32` value + 1-byte `flags` in
   [`layers.ts`](../packages/contracts/src/layers.ts)) uses bits `0..4`
   (`STATUS_MASK = 3`, `SUPPORT_MASK = 28`), leaving bits `5..7` (`32, 64, 128`)
   free for regime flags such as `SUPPORT_CUMULUS` ($z_{\text{LCL}} < z_i$) and
   `SUPPORT_OVERDEVELOPED` (high top-of-lift relative humidity and deep cloud
   depth), exposed automatically in `/sample` and
   [`formatSupportFlags`](../packages/contracts/src/client-view.ts).
2. **Tier 2 — 2D scalar channels (`samples.bin` + optional `.pmtiles`):**
   `MAX_SAMPLE_VALUES = 256` supports up to 10 scalar layers across 24 frames
   (`240 <= 256` channels; ~`2.1 KiB` per layer per 18-cell block read, well
   within `MAX_SAMPLE_RANGE_BYTES = 256 KiB`). Primary map layers
   (`climb-rate`) publish both `samples.bin` channels and `.pmtiles` WebP
   archives; secondary point-series layers (`lcl-msl`, `bl-wind-speed`,
   `bs-ratio`) can be packed into `samples.bin` without generating `.pmtiles`
   raster archives.
3. **Tier 3 — 3D upper-air profiles (batch-time consumption + native
   `profiles.bin`):** 3D upper-air humidity (`SPFH` / `QV`) and wind (`U` / `V`)
   are consumed during batch derivation to compute $\theta_v(z)$ crossings,
   `SUPPORT_OVERDEVELOPED`, and `bs-ratio` at zero storage cost, and optionally
   quantized into a companion $16 \times 16$ block-indexed `profiles.bin` on the
   native grid (`~8 bytes/level`) for `/profile` Skew-T and Windgram queries.
4. **Fast spatial delivery (0-request hover, 1-request routes, and immutable
   $16 \times 16$ blocks):**
   - **0-request hover readout:** because quantized `linear-rgb` tiles (`176`
     LUT steps) map each RGB color uniquely back to a height bin (`±18 m`), the
     client can read loaded WebP tile pixels on `mousemove` for instant `0 ms`
     altitude tooltips without network calls.
   - **Single-request route cross-sections:** a 100 km XC route across a 1 km
     refinement patch intersects only `6–8` spatial blocks (`16 × 16 km` each)
     in [`sample-pack.ts`](../packages/forecast/src/sample-pack.ts). Grouping
     waypoint samples by `blockSlot` in [`serveSample`](../apps/api/src/sample.ts)
     and caching `69 KiB` blocks in Worker / Edge Cache serves full 24-hour
     route cross-sections in a single HTTP request (`~20–40 ms`).
   - **Client-cached $16 \times 16$ blocks and quantized wire records:** serving
     immutable $16 \times 16$ spatial blocks (`~20 KiB` compressed per block)
     lets the browser run [`sampleCells`](../packages/forecast/src/sampler.ts)
     locally at 60 FPS while dragging turnpoints or changing sink-rate presets;
     quantizing altitudes to `Uint16` (`0.5–1 m` steps, `2 B`) and climb/wind to
     `Uint8`/`Int8` (`0.05–0.5 m/s` steps, `1 B`) packs 7 soaring variables into
     the same byte budget as 2 `Float32` channels.

## 1. 1 km terrain-column baseline & sampling invariants (`@av/soaring`, `@av/forecast`, `@av/contracts`)

- **Donor-native surface excess:** evaluate each donor's 2 m excess at its own
  terrain height $\delta_i = T_{2\text{m},i} - E_i(h_i)$ and transfer
  $T_f = E_{\text{supported}}(h_f) + \sum w_i \delta_i$ in
  [`terrain-column.ts`](../packages/forecast/src/terrain-column.ts).
- **Consistent supported-donor surface closure:** weight reference terrain $h_0$,
  surface pressure $p_0$, temperature $T_0$, and humidity $q_0$ by the same
  height-supported donor weights used for $E_{\text{supported}}(h_f)$, falling
  back lazily to [`prepareTerrainClearance`](../packages/forecast/src/refinement.ts)
  only on cells where all donors exceed `maximumBelowGroundExtrapolationM`.
- **Mixed `VALID` / `NO_LIFT` bilinear MSL invariant (`@av/forecast/sampler`):**
  in [`reduceKnownQuad` and `reduceCells`](../packages/forecast/src/sampler.ts),
  prevent `STATUS_NO_LIFT` cells (which store bare terrain height $h_i$ in
  `usable-lift-msl`) from pulling adjacent `STATUS_VALID` thermal ceilings
  upward toward high mountain ground; interpolate MSL across `STATUS_VALID`
  contributors or as interpolated terrain plus interpolated AGL so
  $\text{MSL} = \text{Terrain} + \text{AGL}$ holds across every sub-grid sample
  and tile pixel.
- **Refinement patch boundary feathering (`apps/batch/src/raster.ts`):** blend
  1 km patch fields with base native fields across a narrow border collar in
  [`compositeGeometry`](../apps/batch/src/raster.ts) to eliminate hard seams at
  polygon boundaries.
- **Indexed smooth tiles:** quantize `linear-rgb` interpolation in
  [`palette-color.ts`](../packages/contracts/src/palette-color.ts) and average
  valid quarter-pixel scalar samples in
  [`raster.ts`](../apps/batch/src/raster.ts) before color lookup so lossless
  `VP8L` WebP uses 8-bit color indexing.

## 2. Zero-extra-fetch physics and temporal flux alignment

- **Trailing-window to valid-time solar flux alignment (`@av/solar`, `@av/forecast`):**
  scale multi-hour trailing mean surface fluxes (such as 3-hour GFS windows vs.
  1-hour ICON-EU windows) to the instantaneous profile `validTime` using the
  ratio of [`solarFluxFactor`](../packages/solar/src/position.ts) at `validTime`
  to the window mean so morning ramp-up and late-afternoon decay are not lagged
  by the accumulation window width.
- **Thermal climb rate (`w*` / net climb layer):** publish `thermalVelocityMps`
  already computed by [`deriveLift`](../packages/soaring/src/column.ts) in
  [`science.ts`](../packages/forecast/src/science.ts) as a Tier 2 scalar
  climb-rate layer (`m/s`).
- **Cloud-base (`LCL`) cap and cumulus support bit:** compute Bolton dewpoint
  $T_d$ and [`lclHeightMetersAgl`](../packages/thermodynamics/src/index.ts) in
  [`column.ts`](../packages/soaring/src/column.ts) to cap usable VFR depth at
  $\min(z_{\text{usable,dry}}, z_{\text{LCL}})$, set Tier 1 `SUPPORT_CUMULUS` in
  `flags`, and optionally pack `lcl-msl` in `samples.bin`.
- **Topographic solar incidence and self-shadowing:** combine precomputed 1 km
  DEM slope normals $(n_E, n_N, n_U)$ with direct East-North-Up solar vectors
  $(s_E, s_N, s_U)$ to zero direct beam flux on self-shadowed slopes
  ($\mathbf{n}\cdot\mathbf{s} \le 0$) and scale daytime sensible heat flux and
  positive surface excess by relative direct + diffuse irradiance.
- **Sub-grid DEM aggregation:** aggregate `90 m` GLO-90 elevations (mean and
  ridge-envelope percentile) and slope vectors per 1 km cell in
  [`terrain/prepare.ts`](../apps/batch/src/terrain/prepare.ts) to preserve
  narrow summits and ridge geometry.

## 3. Compute and precomputation optimizations

- **Trig-free projected daylight and solar incidence (`@av/solar`, `@av/forecast`):**
  cache per-cell $(\sin\phi, \cos\phi, \sin\lambda, \cos\lambda)$ and DEM normal
  $(n_E, n_N, n_U)$ once during `prepareTerrainColumns` (when `gridToGeographic`
  already runs), and evaluate Greenwich solar hour angle $(\sin\omega_0, \cos\omega_0)$
  once per timestamp so per-cell daylight and 3D slope incidence $(s_E, s_N, s_U)$
  reduce to 6 multiplies and 3 adds with zero per-frame inverse-projection or
  trigonometric calls.
- **Cached donor lowest-layer lapse and monotonic knot cursor (`@av/soaring`):**
  store each donor's clamped lowest-layer lapse rate $\gamma_i$ in
  `ReconstructedProfileWorkspace.admit()` and advance a 4-donor level cursor
  monotonically across ascending heights in `reconstruct()` instead of
  re-dividing $\gamma_i$ and rescanning from level `0` at every knot.
- **Cube-root-free Lenschow inversion (`@av/soaring/velocity`):** substitute
  $u = \zeta^{1/3}$ in [`usableLiftDepthM`](../packages/soaring/src/velocity.ts)
  to solve the polynomial $a\,u(1 - b\,u^3) = s/w_*$ via Newton-Raphson /
  bracketed steps instead of 60 `Math.cbrt` bisection iterations per cell.
- **Lazy valley clearance fallback:** evaluate terrain-clearance fallback only
  for target cells where all donors exceed `bridgeM` rather than allocating
  full-grid clearance fields on every frame.

## 4. Surface cover, snow, and upper-air moisture/wind

- **Land/water mask and Bowen-ratio flux partitioning:** separate water and land
  donor weights across shorelines (such as Lake Sevan) and partition turbulent
  heat flux ($\text{SHF} + \text{LHF}$) using a static 1 km land-cover table
  (rock, sand, grass, irrigated crops, forest, water).
- **Snow-depth and freezing-surface suppression:** ingest native snow depth
  (`SNOD` / `H_SNOW`) or taper positive surface excess when $E(h_f) \le 0^\circ\text{C}$
  above snow-free donors.
- **Upper-air humidity (`SPFH` / `QV`) and overdevelopment:** include profile
  humidity in [`NormalizedFrame`](../packages/forecast/src/inputs.ts) for
  virtual potential temperature $\theta_v(z)$ crossings and top-of-lift relative
  humidity to set Tier 1 `SUPPORT_OVERDEVELOPED` and cloud depth.
- **Boundary-layer wind and buoyancy-to-shear (`B/S`):** ingest model-level `U`
  and `V` winds into [`NormalizedFrame`](../packages/forecast/src/inputs.ts) to
  publish Tier 2 boundary-layer wind, vertical wind shear, and `bs-ratio`
  thermal climbability.

## 5. XC Skies basic-view parity (Thermal MSL / AGL presentation & point UX)

- **Expose terrain elevation (`terrainM`) on every `/sample` frame:** preserve
  the terrain height already written into `usable-lift-msl` on `STATUS_NO_LIFT`
  cells (and `msl - agl` on valid cells) in
  [`serveSample`](../apps/api/src/sample.ts) so the client always knows exact
  model/DEM ground elevation at the clicked point without extra channels.
- **Single-click point readout and diurnal bar chart (`@av/contracts/client`):**
  auto-fetch `/sample` on map click to show an immediate callout (`MSL`, `AGL`,
  `Terrain`, and `Cu`/`Blue` badge for the active frame) plus a clickable
  daytime bar chart (ground floor + usable lift column) alongside the table.
- **Units (`m` / `ft`) and local solar/timezone time formatting:** round
  displayed heights to whole meters/feet in
  [`client-view.ts`](../packages/contracts/src/client-view.ts) (instead of raw
  `Float32` decimals), add a client `m` / `ft` toggle for legends and readouts,
  and display local time alongside UTC.
- **Basemap hillshade, roads/labels above overlay, and patch outline:** place
  terrain hillshade beneath [`OVERLAY_LAYER_ID`](../apps/preview/src/main.ts),
  render roads, borders, and place/peak labels in a symbol layer above the
  forecast raster, render refinement polygon outlines (`zone-001`), and allow
  `maxZoom: 9` inside 1 km patches.
- **Flicker-free frame scrubbing (`←` / `→`):** update or prefetch tile sources
  across adjacent frames in [`apps/preview/src/main.ts`](../apps/preview/src/main.ts)
  without tearing down the active MapLibre layer on every step.

## 6. Route cross-sections, soundings, high-res feeds, and calibration

- **Route cross-sections and client block caching:** extend
  [`serveSample`](../apps/api/src/sample.ts) to accept a waypoint polyline
  (grouping reads by $16 \times 16$ `blockSlot` with Worker/Edge block caching)
  and optionally expose immutable $16 \times 16$ spatial blocks so the browser
  can evaluate [`sampleCells`](../packages/forecast/src/sampler.ts) locally at
  60 FPS while dragging route waypoints.
- **Atmospheric profiles (`profiles.bin`):** pack quantized native-grid vertical
  profiles in $16 \times 16$ spatial blocks for interactive Skew-T and Windgram
  sounding charts.
- **Additional public NWP adapters:** add pluggable providers for
  `0.1°` ECMWF IFS Open Data and `2–3 km` regional convection-permitting feeds
  (`ICON-D2`, `HRRR`, `AROME`).
- **Station, radiosonde, and IGC flight-log MOS + regional `1.5–2 km` runs:**
  fit terrain and diurnal bias corrections against historical stations,
  soundings (`UGEE`), and IGC flight logs, and composite the highest-skill
  provider per region and lead time into a single unified soaring layer.
