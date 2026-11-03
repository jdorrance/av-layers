# Science and sampling

[`@av/soaring`](../packages/soaring/README.md) and
[`@av/thermodynamics`](../packages/thermodynamics/README.md) solve dry thermal
lift for a single atmospheric column. [`@av/forecast`](../packages/forecast/README.md)
runs the column solver across a grid, gates daylight cells with
[`@av/solar`](../packages/solar/README.md), and interpolates values for tiles and
point queries. See [data](data.md) for output units and status meanings.

## Input fields

- **GFS** ([fields.ts](../apps/batch/src/gfs/fields.ts), [gfs.json](../packages/contracts/config/gfs.json)):
  model terrain, surface pressure, 2 m temperature and specific humidity,
  sensible and latent heat flux, PBL height, precipitation rate, and
  isobaric-level geopotential height and temperature (`pressureLevelsHpa`).
- **ICON-EU** ([icon/README.md](../apps/batch/src/icon/README.md), [icon-eu.json](../packages/contracts/config/icon-eu.json)):
  DWD's 0.0625° regular latitude/longitude grid, surface fields (`HSURF`, `PS`,
  `T_2M`, `QV_2M`, `MH`, `ASHFL_S`, `ALHFL_S`), static half-level heights `HHL`
  (`45..75`, midpoint-averaged into full-level heights and verified against
  `HSURF` at half-level `75`), and per-column pressure `P` and temperature `T`
  on model levels `45..74`.

Specific humidity converts to mixing ratio via $r = q / (1 - q)$. Below-ground
profile levels are screened before column derivation; levels with missing
pressure are marked invalid. A [normalized frame](../packages/forecast/src/inputs.ts)
stores each field as a `Float32Array` paired with a binary `Uint8Array`
missingness mask.

[Frame derivation](../packages/forecast/src/frame.ts) evaluates solar elevation
across each cell's trailing interval and valid time using
[`@av/solar/grid`](../packages/solar/src/grid.ts) (`minimumSolarElevationDeg = -0.833°`).
Dark cells emit `STATUS_NO_LIFT` on lift layers and `STATUS_UNAVAILABLE` on
`precip-rate`. For `regional-daylight` products (ICON-EU),
[daylight frame selection](../packages/forecast/src/daylight.ts) also filters out
candidate forecast hours before acquisition when no covered output cell is sunlit
at the interval start, midpoint, or end.

## Statistical windows

The [GFS](../apps/batch/src/gfs/intervals.ts) and
[ICON](../apps/batch/src/icon/acquire.ts) adapters verify continuous statistical
windows in GRIB2 metadata and pass them to
[`@av/forecast/intervals`](../packages/forecast/src/intervals.ts):

- For two means sharing start $a$, the trailing `[t1, t2]` mean is
  $\frac{(t_2 - a)\,\overline{X}_{[a,t_2]} - (t_1 - a)\,\overline{X}_{[a,t_1]}}{t_2 - t_1}$.
- ICON-EU `ASHFL_S` and `ALHFL_S` are run-averaged (`0..h`) downward fluxes;
  differencing consecutive hours and negating yields the preceding-hour upward
  flux (`f001` negates its `0..1h` mean directly).
- Small negative precipitation differences within combined GRIB packing error
  clamp to `0`; larger negative rates become `unavailable`.
- Lift pairs the trailing-interval surface heat fluxes with the valid-time
  temperature profile and PBL depth.

## Lift depth and usable top

`dry-lenschow-pbl-1p2-v1` (isobaric) and `dry-lenschow-pbl-1p2-model-levels-v1`
(model levels) lift a dry parcel from the surface at `dryLapseRateKperM = 0.0098 K/m`
([`@av/thermodynamics/constants`](../packages/thermodynamics/src/constants.ts)).
Profiles require ascending heights above ground with gaps $\le 1,000\text{ m}$.
Where parcel temperature excess crosses from positive to nonpositive, linear
interpolation gives the thermal top; if the profile remains buoyant at the top
resolved level, depth caps at that level (`SUPPORT_CAPPED`). When surface
buoyancy flux is positive and the first profile level is neutral or stable,
depth closes to $\min(z_1, \text{PBL})$ (`SUPPORT_PBL`).

Deardorff convective velocity $w_*$ (`m/s`) scales the Lenschow updraft profile
in [`@av/soaring/velocity`](../packages/soaring/src/velocity.ts). Usable lift
requires updraft velocity to exceed `sinkRateMps` (`1.2 m/s` default in
[`@av/soaring/parameters`](../packages/soaring/src/parameters.ts)); the upper
crossing with `sinkRateMps` sets the usable thermal depth ([column.ts](../packages/soaring/src/column.ts)).

## Terrain clearance

Method `native-lift-terrain-clearance-v1` derives fine AGL in the configured
polygons. [`prepareTerrainClearance`](../packages/forecast/src/refinement.ts)
compiles native neighbors and weights once per target grid. Each target cell
requires every positive-weight native neighbor to have known, matching lift status.
Valid lift gives `max(0, interpolated MSL ceiling − DEM elevation)`; all-no-lift
neighbors give zero. Mixed lift/no-lift neighborhoods, missing DEM and missing
native support remain unavailable.

Daylight follows the same interval as the parent frame. A dark cell with valid
terrain and complete native geometric support emits no lift without evaluating
the atmospheric values. Missing terrain or geometric support stays unavailable.
MSL and atmospheric column calculations remain native. Clearance can include
space below model ground; it does not establish thermals originating at the
local DEM surface. Each patch records the DEM datum and surface type. The
calculation applies no vertical-datum transformation.

## Reconstruction and storage

[`@av/forecast/sampler`](../packages/forecast/src/sampler.ts) checks coverage
membership, snaps coordinates within $10^{-10}$ grid steps, wraps periodic
longitudes, and ignores zero-weight neighbors. Known contributors interpolate
bilinearly, using `0` AGL / model-terrain MSL for no-lift cells; public no-lift
results follow [data](data.md#layers-and-missing-values). If a contributing cell
is `unavailable` or `outside-domain`, the nearest contributing cell supplies
the value and status.

Tile rendering evaluates four quarter-pixel subsamples in Web Mercator, applies
the layer palette, and averages premultiplied RGBA before encoding lossless
WebP. Point samples are stored in 5-byte records (`Float32` value + 1-byte
status/support bitmask defined in [layers.ts](../packages/contracts/src/layers.ts))
arranged in $16 \times 16$ cell blocks with a 1-cell halo ([architecture](architecture.md#build-and-storage)).

## Algorithm sources

The solar, thermodynamic, and dry-lift equations are adapted from Windgrams
([provenance.json](../packages/forecast/provenance.json)). Source-data and
third-party licenses are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
