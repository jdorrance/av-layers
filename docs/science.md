# Science and sampling

Lift is calculated from each model column using
[`@av/soaring`](../packages/soaring/README.md) and
[`@av/thermodynamics`](../packages/thermodynamics/README.md).
[`@av/forecast`](../packages/forecast/README.md) applies the calculation across a
grid, checks daylight with [`@av/solar`](../packages/solar/README.md), and samples
the results for maps and point queries. See [data](data.md) for output units and
status meanings.

## Input fields

GFS acquisition uses model terrain and surface pressure, two-metre temperature
and humidity, sensible and latent heat flux, PBL height, precipitation, and
pressure-level height and temperature. The [field definitions](../apps/batch/src/gfs/fields.ts)
and [GFS settings](../packages/contracts/config/gfs.json) define source products,
pressure levels, and forecast hours.

ICON-EU uses DWD's regular grid, surface fields and the lowest 30 model levels.
Pressure comes from each column's `P` fields in Pa, with temperature from `T`.
Adjacent static `HHL` interfaces supply full-level midpoint heights; the bottom
interface must agree with `HSURF` terrain. The [ICON adapter](../apps/batch/src/icon/README.md) reads the fields listed in
[ICON settings](../packages/contracts/config/icon-eu.json). This supports lift only and performs no 1 km terrain
downscaling or reconstruction of hybrid-coordinate pressure.

Both adapters check decoded parameter, level, grid, initialization, packing and
statistical-window metadata. GFS also checks inventory labels. Duplicate inventory
matches are accepted only when every candidate is a bounded, complete,
byte-identical GRIB message. Source records retain all candidates; conflicting bytes
remain an error. A required acquisition failure stops the build, while decoded
per-cell missingness propagates through the affected layer.

Specific humidity is converted directly to mixing ratio, `r = q / (1 - q)`.
The solver also accepts dew point through the same saturation formulation.
Explicit pressure and humidity avoid sea-level-pressure and dry-air fallbacks.
Below-ground levels are screened before column derivation. A missing pressure
observation cannot establish that a level is below ground; it remains an invalid
observation rather than allowing interpolation across an unknown inversion.
A [normalized frame](../packages/forecast/src/inputs.ts) stores each field in a
compact Float32 array with a binary missing-value mask. A frame carries either
GFS's strictly descending shared isobaric axis in hPa or ICON's per-column Pa
arrays and pressure masks, according to its product capabilities. Precipitation
arrays are required only for products that publish rain and are normalized to
mm/h. Nonfinite values require an explicit missing flag; invalid array types,
shapes or active-index identity stop the build.

[Frame derivation](../packages/forecast/src/frame.ts) evaluates solar elevation
across each cell's trailing interval and valid time using
[`@av/solar/grid`](../packages/solar/src/grid.ts) (`minimumSolarElevationDeg = -0.833°`),
skipping nighttime cells before profile extraction (`STATUS_NO_LIFT` for lift layers
and `STATUS_UNAVAILABLE` for precipitation). For daytime cells, it performs below-ground
screening and unit conversion, then reuses a level scratch array with an explicit active
count. Unused tail entries never enter the solver. Reuse changes allocation behavior,
not profile selection, physical assumptions or branch tolerances.

For ICON-EU, [frame selection](../packages/forecast/src/daylight.ts) also checks
regional daylight before acquisition, dropping a candidate hour when no covered
output cell is sunlit at its interval start, midpoint or end. The configured
candidate horizon remains hourly +1 through +24, including tomorrow's daylight
when a run starts at night. This does not remove the preceding-hour flux
companions needed to recover a retained hour. GFS keeps all candidate frames.
If no candidate has daylight at all, selection retains the candidate list so
the product can publish explicit nighttime no-lift values instead of an empty
build.

## Statistical windows

The GFS adapter verifies continuous statistical intervals from decoded GRIB
metadata across 1-hour forecast steps (`+1h..+24h`). For two means sharing start `a`,
it recovers the trailing mean as
`((t2-a) × mean(a,t2) - (t1-a) × mean(a,t1)) / (t2-t1)`.
Block resets are respected; a later lead is not necessarily an
initialization-to-lead mean. Compatible accumulation differences become rain
rates after division by the interval duration. ICON's `ASHFL_S` and `ALHFL_S`
are initialization-to-lead downward means. Their consecutive-hour difference
uses the same trailing-mean calculation and reverses the sign to upward; hour 1
uses its own mean directly without requiring an hour-0 companion.

Small negative precipitation differences within the combined GRIB packing-error
tolerance become zero; larger negatives become unavailable. Cooling flux remains
signed. The [NOAA](../apps/batch/src/gfs/intervals.ts) and
[ICON](../apps/batch/src/icon/grib.ts) adapters check runs, grids, windows and
processing semantics before differencing.
[`@av/forecast/intervals`](../packages/forecast/src/intervals.ts) then calculates
the trailing values and applies the quantization tolerance.
GFS cumulative/mean companions remain Float64 until recovery, then compact to
Float32. ICON retains its decoded Float32 fields. Lift combines interval flux
with the endpoint profile and PBL, an explicit temporal approximation recorded
in the manifest. Both products start at `f001`, without prior-cycle substitution
or temporal interpolation.

## Lift depth and usable top

Method `dry-lenschow-pbl-1p2-v1` follows a dry parcel from the surface using a
configurable dry-adiabatic lapse rate (`dryLapseRateKperM = 0.0098 K/m` in
[`@av/thermodynamics/constants`](../packages/thermodynamics/src/constants.ts)). Profiles have
ascending above-ground heights and at most 1,000 m gaps, including the first
observation. A positive-to-nonpositive parcel temperature excess gives an
interpolated crossing. If the profile ends first, the result is limited to its
observed top.

PBL closes only the first-layer case: with positive buoyancy flux and a
nonpositive first-level excess, depth is the smaller of first-level height and
positive model PBL depth. Missing PBL invalidates that branch alone; resolved
crossings above PBL remain intact. Verified nonpositive buoyancy flux gives no
lift. There is no heat-flux-only depth fallback, cloud cap or moist continuation.

Surface-density-consistent Deardorff velocity $w_*$ (`m/s`) scales the Lenschow
updraft curve in [`@av/soaring`](../packages/soaring/src/index.ts). All velocity
thresholds in `m/s` (`sinkRateMps = 1.2 m/s`, `minimumThermalVelocityMps = 0 m/s`,
and aircraft presets `SINK_RATE_PRESETS_MPS`) are defined in
[soaring parameters](../packages/soaring/src/parameters.ts) and the
[velocity module](../packages/soaring/src/velocity.ts), and are overridable per call.
[Method descriptors](../packages/contracts/src/methods.ts) publish the operational defaults.
A peak below `sinkRateMps` gives no usable lift; a top that meets the threshold
retains that top; otherwise the descending threshold crossing sets the usable depth.
[The solver](../packages/soaring/src/column.ts) uses those defaults, and
[its tests](../packages/forecast/src/science.test.ts) cover branch boundaries.

## Reconstruction and storage

The [shared sampler](../packages/forecast/src/sampler.ts) first applies output
coverage. It snaps coordinates within `1e-10` grid steps of a node, wraps periodic
longitude and ignores zero-weight neighbours. All contributing cells must be
known for bilinear interpolation. Otherwise the nearest contributor supplies
its value and status; ties prefer the lower row, then wrapped column. There is
no renormalization, substitute neighbour or nonperiodic edge extrapolation.

Internally, no-lift contributes zero AGL and model terrain MSL. Public all-no-lift
results follow [the missing-value rules](data.md#layers-and-missing-values).
Support flags union only the actual contributors. Rendering samples four fixed
quarter-pixel offsets in global Web Mercator coordinates, palettes each scalar,
and averages premultiplied colour before encoding straight alpha.
Each zoom is evaluated independently. Grouping a frame's layers by tile only
shares prepared geometry; it does not average child colours into parent tiles,
regrid a projected source or alter coverage-edge decisions.

Each numeric record contains a little-endian `Float32` value followed by a
status/support byte. The low two
bits encode status; three further bits identify parcel crossing, profile top
and PBL closure. [layers.ts](../packages/contracts/src/layers.ts) defines these constants. Grid geometry, Earth radius, bounds and wrap behavior come from the
immutable version-3 manifest and its content-addressed coverage descriptor.
Native Lambert-conformal grids are sampled through their declared projection;
the current GFS and ICON-EU providers both supply regular latitude/longitude
grids. The sampler finds the contributing cells; the [numeric block layout](architecture.md#build-and-storage)
maps them to one bounded range, including longitude-wrap cases.

## Algorithm sources

The solar, thermodynamic and dry-lift calculations were adapted from Windgrams.
[provenance.json](../packages/forecast/provenance.json) lists the source revision
and files. The implementations here use the dry-column method described above;
they do not include Windgrams' cloud caps or estimates for missing pressure and
humidity. Source-data and dependency licences are listed in
[THIRD_PARTY_NOTICES](../THIRD_PARTY_NOTICES.txt).
