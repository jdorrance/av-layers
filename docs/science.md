# Science and sampling

[`@av/soaring`](../packages/soaring/README.md) and
[`@av/thermodynamics`](../packages/thermodynamics/README.md) solve dry thermal
lift for a single atmospheric column. [`@av/forecast`](../packages/forecast/README.md)
runs the column solver across a grid, gates daylight cells with
[`@av/solar`](../packages/solar/README.md), and interpolates values for tiles and
point queries. See [data](data.md) for output units and status meanings.

## Input fields

[models.json](../packages/contracts/config/models.json) selects source grids,
fields, levels and intervals. The [indexed adapter](../apps/batch/src/indexed-grib/README.md)
supplies GFS and RRFS isobaric heights and temperatures; the
[split adapter](../apps/batch/src/split-grib/README.md) supplies ICON-EU per-column
pressure and temperature. Full-level heights average adjacent half levels;
the bottom half level must match model terrain. All sources provide terrain,
surface pressure, 2 m temperature and specific humidity, and sensible and latent
heat flux. Indexed sources also supply precipitation accumulations.

Specific humidity converts to mixing ratio via $r = q / (1 - q)$. Below-ground
profile levels are screened before column derivation; levels with missing
pressure are marked invalid. A [normalized frame](../packages/forecast/src/inputs.ts)
stores each field as a `Float32Array` paired with a binary `Uint8Array`
missingness mask.

[Frame derivation](../packages/forecast/src/frame.ts) evaluates solar elevation
across each cell's trailing interval and valid time using
[`@av/solar/grid`](../packages/solar/src/grid.ts) (`minimumSolarElevationDeg = -0.833°`).
Dark lift cells with known ground elevation emit `STATUS_NO_LIFT`.
Current precipitation uses the trailing interval at all hours. Retained
precipitation v1 builds mark dark cells unavailable. For `regional-daylight`
products, [daylight frame selection](../packages/forecast/src/daylight.ts) keeps
hours with daylight in the covered grid and keeps the full candidate list when
none qualify, including polar night.

## Statistical windows

The [indexed](../apps/batch/src/indexed-grib/intervals.ts) and
[split](../apps/batch/src/split-grib/acquire.ts) adapters verify continuous statistical
windows in GRIB2 metadata and pass them to
[`@av/forecast/intervals`](../packages/forecast/src/intervals.ts):

- For two means sharing start $a$, the trailing `[t1, t2]` mean is
  $\frac{(t_2 - a)\,\overline{X}_{[a,t_2]} - (t_1 - a)\,\overline{X}_{[a,t_1]}}{t_2 - t_1}$.
- GFS recovers hourly fluxes and precipitation from its configured reset windows.
- RRFS selects preceding-hour mean `SHTFL` and `LHTFL` and preceding-hour
  accumulated `APCP` directly. [NOAA's surface inventory](https://www.nco.ncep.noaa.gov/pmb/products/rrfs/rrfs.t06z.2dfld.3km.f004.conus.grib2.shtml)
  also lists instantaneous fluxes and run-total precipitation; decoded windows
  must match the requested trailing interval.
- ICON-EU `ASHFL_S` and `ALHFL_S` are run-averaged (`0..h`) downward fluxes;
  differencing consecutive hours and negating yields the preceding-hour upward
  flux (`f001` negates its `0..1h` mean directly).
- Small negative precipitation differences within combined GRIB packing error
  clamp to `0`; larger negative rates become `unavailable`.
- Lift pairs the trailing-interval surface heat fluxes with the valid-time
  temperature profile.

## RRFS and Windgrams

RRFS uses [NOAA's CONUS Lambert output](https://www.nco.ncep.noaa.gov/pmb/products/rrfs/)
through the shared indexed adapter and dry-column solver. Its supplied surface
pressure and preceding-hour heat-flux means feed the existing terrain-column
calculation. Historical Windgrams RRFS profiles used instantaneous heat fluxes.

An 84-hour replay of the archived `rrfs-blanchard-published.json` profile
(2026-10-23 06Z) compared Windgrams 2.3 calculations with the same pressure,
humidity, convective depth, unrounded velocity, 1.2 m/s sink and no cloud cap.
The maximum velocity difference was $1.11\times10^{-16}$ m/s; usable depths
matched exactly. Windgrams' own depth policy differed in 43 hours through its
model-PBL fallback. The archive contains rounded inputs; this replay checks
equation agreement. Production retains the parcel crossing, below-ground
support and sink rules below. Windgrams' model-PBL and heat-flux depth fallbacks,
pressure estimation and cloud caps describe its separate diagnostic policies.

## Lift depth and usable top

`dry-lenschow-1p2-v2` (isobaric) and `dry-lenschow-1p2-model-levels-v2`
(model levels) lift a dry parcel from the surface at `dryLapseRateKperM = 0.0098 K/m`
([`@av/thermodynamics/constants`](../packages/thermodynamics/src/constants.ts)).
Profiles require ascending heights above ground with gaps $\le 1,000\text{ m}$.
Neutral levels within the propagated Float32 temperature and height rounding
bound continue the search. The first strictly negative parcel excess
after a resolved level gives a linearly interpolated crossing
(`SUPPORT_PARCEL_CROSSING`); without a crossing, depth caps at the highest
profile level (`SUPPORT_PROFILE_TOP`), leaving the atmospheric top unresolved.
If the first level is negative, extrapolate its environmental temperature to
ground using the first two levels' lapse rate clamped to zero through the dry
lapse rate, or the dry lapse rate for one level. Nonpositive surface excess
gives zero depth; otherwise interpolate the crossing from ground.

Screening levels at model ground can introduce jumps. For surface temperature
20 °C and levels (500 m, 21 °C), (1000 m, 14 °C), (1500 m, 11 °C), terrain
499 m gives zero depth while terrain 500 m screens the first level and gives
789.47 m depth.

Deardorff convective velocity $w_*$ (`m/s`) scales the Lenschow updraft profile
in [`@av/soaring/velocity`](../packages/soaring/src/velocity.ts). Usable lift
requires updraft velocity to exceed `sinkRateMps` (`1.2 m/s` default in
[`@av/soaring/parameters`](../packages/soaring/src/parameters.ts)); the upper
crossing with `sinkRateMps` sets the usable thermal depth ([column.ts](../packages/soaring/src/column.ts)).

## Terrain clearance

Method `native-lift-terrain-clearance-v2` supplies unsupported-valley fallback
and evaluation controls. [`prepareTerrainClearance`](../packages/forecast/src/refinement.ts)
compiles native neighbors and weights once per target grid. Each target cell
requires complete native diagnostics. Every positive-weight neighbor must have
positive convective depth for interpolation. The method interpolates convective-depth
top MSL and buoyancy $B=w_*^3/\mathrm{depth}$, sets local depth to
`max(0, top - DEM)`, and applies `usableLiftDepthM(depth, cbrt(B * depth))`.
Native no-lift columns with positive depth participate. All non-convective or
surface-stable contributors yield no lift; a mixture with convective contributors
is unavailable. Missing DEM or native support remains unavailable. Contributor
support flags are ORed.

Daylight follows the same interval as the parent frame. A dark cell with valid
terrain and complete native geometric support emits no lift without evaluating
the atmospheric values. Missing terrain or geometric support stays unavailable.
The method returns MSL as DEM elevation plus usable clearance and AGL as that
clearance. Valleys inherit the parent model's convective top and buoyancy
forcing over a deeper local layer. Each patch records the DEM datum and surface
type. The calculation applies no vertical-datum transformation.

## Terrain columns

Production uses [`preparePackedTerrainColumns`](../packages/forecast/src/terrain-column.ts)
(and [`prepareTerrainColumns`](../packages/forecast/src/terrain-column.ts) in regional patch evaluation)
to reconstruct an environmental profile at each DEM cell from native donors.
[Method descriptors](../packages/contracts/src/methods.ts) select the configured
isobaric or per-column model-level pressure axis. Surface
excess is evaluated at each native ground: $\delta_i=T_{2m,i}-E_i(h_i)$.
The transferred excess is $\delta_0=\sum_i w_i\delta_i$ using the original
horizontal weights. The solver lifts a parcel from $E(h_f)+\delta_0$.
Surface-state temperature is $T_f=E_\mathrm{surface}(h_f)+\delta_0$.
The workspace's surface-ground diagnostic damps below-ground depth as
$d_\mathrm{eff}=d/(1+2d/b)$ for bridge bound $b$. Hydrostatic pressure uses
mean virtual temperature.

For ground-supported weights $v_i$, relative humidity is interpolated as
$RH_f=\sum_i v_i e_i/e_s(T_i)$. Native vapor pressure $e_i$ uses the corrected
specific humidity from [column-input.ts](../packages/forecast/src/column-input.ts).
Fine vapor pressure is $e_f=RH_f e_s(T_f)$, and specific humidity is
$q_f=\epsilon e_f/[p_f-(1-\epsilon)e_f]$, with $p_f$ and $e_f$ in the same
pressure units. Sensible and latent heat fluxes use the same supported weights.

At height $z$, environmental weights are normalized among validated donors
within their admitted below-ground support. The solver-owned
[workspace](../packages/soaring/src/column.ts) merges atmospheric heights,
native grounds and support-entry heights, retaining one-sided temperatures at
support changes. Raw observation and atmospheric-top checks bound this profile.
The explicit ground anchor uses the native Float32 crossing tolerance. A
one-donor, own-ground cell follows the native solve exactly.

When no donor supports the fine ground, valid same-frame terrain clearance
supplies a legacy height estimate. Its local thermodynamic state remains unknown.
Native missing-data errors retain their availability checks.

[TopoSCALE](https://doi.org/10.5194/gmd-7-387-2014) describes height interpolation
of free-atmosphere fields. The [mountain CBL review](https://doi.org/10.3389/feart.2015.00077)
describes regime-dependent terrain relationships. The donor anomaly, support
selection and clearance fallback here are project numerical rules requiring
local validation.

The [evaluation command](../apps/batch/src/refinement/README.md#evaluation)
records paired fields, status/support changes and station comparisons.
[Whole-domain admission](../apps/batch/src/whole-domain/capacity.ts) and
[legacy patch admission](../apps/batch/src/capacity.ts) account for the retained mappings,
solver workspace and fallback fields.

## Reconstruction and storage

[`@av/forecast/sampler`](../packages/forecast/src/sampler.ts) checks coverage
membership, snaps coordinates within $10^{-10}$ grid steps, wraps periodic
longitudes, and ignores zero-weight neighbors. No-lift contributors store zero
AGL and surface elevation in MSL. When no-lift weights exceed half the total,
the result uses the public [no-lift values](data.md#layers-and-missing-values).
Otherwise, known contributors interpolate bilinearly. New builds mark
`tool.useStoredMslNoLift` and use the stored MSL elevations throughout. Earlier
builds renormalize the MSL weights over valid cells in a four-cell mix. If a
contributor is unavailable or outside the domain, the nearest contributing cell
supplies the value and status.

Tile rendering evaluates four quarter-pixel subsamples in Web Mercator. Linear
lift palettes colour the mean valid value and scale alpha by valid coverage.
Other paths, including rain, average premultiplied RGBA. The renderer encodes
lossless WebP. Render style changes the recipe identity while preserving numeric
packs. [Layer descriptors](../packages/contracts/src/layers.ts) select palettes.
Point samples are stored in 5-byte records (`Float32` value + 1-byte
status/support bitmask defined in [layers.ts](../packages/contracts/src/layers.ts))
arranged in $16 \times 16$ cell blocks with a 1-cell halo ([architecture](architecture.md#build-and-storage)).

## Algorithm sources

The solar, thermodynamic, and dry-lift equations are adapted from Windgrams
([provenance.json](../packages/forecast/provenance.json)). Source-data and
third-party licenses are in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).
