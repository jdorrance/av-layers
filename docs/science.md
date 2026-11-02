# Science and sampling

The forecast package derives lift from model columns, then reconstructs
those fields for samples and tiles. [Reading the forecast](data.md) defines their
public meaning.

## Input fields

GFS acquisition uses model terrain and surface pressure, two-metre temperature
and humidity, sensible and latent heat flux, PBL height, precipitation, and
pressure-level height and temperature. The [field definitions](../apps/batch/src/noaa/fields.ts)
and [GFS settings](../packages/contracts/config/gfs.json) define source products,
pressure levels, and forecast hours.

The adapter checks decoded parameter, level, grid, initialization, packing, and
statistical-window metadata as well as inventory labels. Duplicate inventory
matches are accepted only when every candidate is a bounded, complete,
byte-identical GRIB message. Source records retain all candidates; conflicting bytes
remain an error. A required acquisition failure stops the build, while decoded
per-cell missingness propagates through the affected layer.

Specific humidity is converted directly to mixing ratio, `r = q / (1 - q)`.
The solver also accepts dew point through the same saturation formulation.
Explicit pressure and humidity avoid sea-level-pressure and dry-air fallbacks.
Below-ground levels are screened before column derivation; missing above-ground
levels remain missing. [Acquisition](../apps/batch/src/noaa/acquire.ts) owns source
validation and source records. The [provider boundary](../apps/batch/src/providers.ts)
requires compact Float32 arrays in declared units, binary missing masks and a
strictly descending pressure axis in hPa. Precipitation is normalized to mm/h. Nonfinite values require an explicit missing flag; invalid array
types, shapes or active-index identity stop the build.

[Frame derivation](../packages/forecast/src/frame.ts) evaluates solar elevation
across each cell's trailing interval and valid time using
[`@av/solar`](../packages/solar/src/index.ts) (`minimumSolarElevationDeg = -0.833°`),
skipping nighttime cells before profile extraction (`STATUS_NO_LIFT` for lift layers
and `STATUS_UNAVAILABLE` for precipitation). For daytime cells, it performs below-ground
screening and unit conversion, then reuses a level scratch array with an explicit active
count. Unused tail entries never enter the solver. Reuse changes allocation behavior,
not profile selection, physical assumptions or branch tolerances.

## Statistical windows

The GFS adapter verifies continuous statistical intervals from decoded GRIB
metadata across 1-hour forecast steps (`+1h..+24h`). For two means sharing start `a`,
it recovers the trailing mean as
`((t2-a) × mean(a,t2) - (t1-a) × mean(a,t1)) / (t2-t1)`.
Block resets are respected; a later lead is not necessarily an
initialization-to-lead mean. Compatible accumulation differences become rain
rates after division by the interval duration.

Small negative precipitation differences within the combined GRIB packing-error
tolerance become zero; larger negatives become unavailable. Cooling flux remains
signed. Runs, grids, windows and processing semantics are checked before
differencing. [Interval recovery](../apps/batch/src/noaa/intervals.ts) owns the
tolerances and validation. Raw cumulative/mean companions remain Float64 until
recovery; only the final interval field is compacted to Float32. Lift combines interval flux with the endpoint profile
and PBL, an explicit temporal approximation recorded in the manifest. GFS
`f000` is outside this sample product, with no prior-cycle substitution.

## Lift depth and usable top

Method `dry-lenschow-pbl-1p2-v1` follows a dry parcel from the surface using a
configurable dry-adiabatic lapse rate (`dryLapseRateKperM = 0.0098 K/m` in
[`@av/thermodynamics`](../packages/thermodynamics/src/index.ts)). Profiles have
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
and aircraft presets `SINK_RATE_PRESETS_MPS`) are explicitly parameterized in
[method parameters](../packages/contracts/src/methods.ts) and overridable per call.
A peak below `sinkRateMps` gives no usable lift; a top that meets the threshold
retains that top; otherwise the descending threshold crossing sets the usable depth.
[The solver](../packages/soaring/src/index.ts) uses the shared
[method parameters](../packages/contracts/src/methods.ts), and
[its tests](../packages/forecast/src/science.test.ts) cover branch boundaries.

## Reconstruction and storage

The [shared sampler](../packages/forecast/src/sampler.ts) first applies output
coverage. It snaps coordinates within `1e-10` grid steps of a node, wraps periodic
longitude and ignores zero-weight neighbours. All contributing cells must be
known for bilinear interpolation. Otherwise the nearest contributor supplies
its value and status; ties prefer the lower row, then wrapped column. There is
no renormalization, substitute neighbour or nonperiodic edge extrapolation.

Internally, no-lift contributes zero AGL and model terrain MSL. Public all-no-lift
results follow [the absence contract](data.md#layers-and-missing-values).
Support flags union only the actual contributors. Rendering samples four fixed
quarter-pixel offsets in global Web Mercator coordinates, palettes each scalar,
and averages premultiplied colour before encoding straight alpha.
Each zoom is evaluated independently. Grouping a frame's layers by tile only
shares prepared geometry; it does not average child colours into parent tiles,
regrid a projected source or alter coverage-edge decisions.

Each numeric record contains a little-endian `Float32` value followed by a
status/support byte. The low two
bits encode status; three further bits identify parcel crossing, profile top
and PBL closure. [Layer definitions](../packages/contracts/src/layers.ts) own their
constants. Grid geometry, Earth radius, bounds and wrap behavior come from the
immutable version-3 manifest and its content-addressed coverage descriptor.
Native Lambert-conformal grids are sampled through their declared projection;
the available production forecast remains GFS. The sampler plans
the contributing cells; the [numeric block layout](architecture.md#build-and-storage)
maps them to one bounded range, including longitude-wrap cases.
