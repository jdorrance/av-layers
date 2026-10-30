# Science and sampling

The forecast package derives lift from admitted model columns, then reconstructs
those fields for samples and tiles. [Reading the forecast](data.md) defines their
public meaning.

## Admitted inputs

GFS acquisition uses model terrain and surface pressure, two-metre temperature
and humidity, sensible and latent heat flux, PBL height, precipitation, and
pressure-level height and temperature. The [field definitions](../apps/batch/src/noaa/fields.ts)
and [constants](../apps/batch/src/noaa/constants.ts) own the exact product routing,
pressure levels and forecast leads.

Admission checks decoded parameter, level, grid, initialization, packing and
statistical-window metadata as well as inventory labels. Duplicate inventory
matches are accepted only when every candidate is a bounded, complete,
byte-identical GRIB message. Receipts retain all candidates; conflicting bytes
remain an error. A required acquisition failure stops the build, while decoded
per-cell missingness propagates through the affected layer.

Specific humidity is converted directly to mixing ratio, `r = q / (1 - q)`.
The solver also accepts dew point through the same saturation formulation.
Explicit pressure and humidity avoid sea-level-pressure and dry-air fallbacks.
Below-ground levels are screened before column derivation; missing above-ground
levels remain missing. [Acquisition](../apps/batch/src/noaa/acquire.ts) owns these
conversions and receipts.

## Statistical windows

The GFS adapter verifies continuous statistical intervals from decoded GRIB
metadata. For two means sharing start `a`, it recovers the trailing mean as
`((t2-a) × mean(a,t2) - (t1-a) × mean(a,t1)) / (t2-t1)`.
Block resets are respected; a later lead is not necessarily an
initialization-to-lead mean. Compatible accumulation differences become rain
rates after division by the interval duration.

Small negative precipitation differences within the combined GRIB packing-error
tolerance become zero; larger negatives become unavailable. Cooling flux remains
signed. Runs, grids, windows and processing semantics are checked before
differencing. [Interval recovery](../apps/batch/src/noaa/intervals.ts) owns the
tolerances and validation. Lift combines interval flux with the endpoint profile
and PBL, an explicit temporal approximation recorded in the manifest. GFS
`f000` is outside this sample product, with no prior-cycle substitution.

## Lift depth and usable top

Method `dry-lenschow-pbl-1p2-v1` follows a dry parcel from the surface using a
0.0098 K/m lapse rate. Profiles have ascending above-ground heights and at most
1,000 m gaps, including the first observation. A positive-to-nonpositive parcel
temperature excess gives an interpolated crossing. If the profile ends first,
the result is limited to its observed top.

PBL closes only the first-layer case: with positive buoyancy flux and a
nonpositive first-level excess, depth is the smaller of first-level height and
positive model PBL depth. Missing PBL invalidates that branch alone; resolved
crossings above PBL remain intact. Verified nonpositive buoyancy flux gives no
lift. There is no heat-flux-only depth fallback, cloud cap or moist continuation.

Surface-density-consistent Deardorff velocity scales the Lenschow updraft curve.
A peak below 1.2 m/s gives no usable lift; a top that meets the threshold retains
that top; otherwise the descending threshold crossing sets the usable depth.
[The solver](../packages/forecast/src/science.ts) owns numerical constants and
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

Each numeric record contains a little-endian `Float32` value followed by a
status/support byte. The low two
bits encode status; three further bits identify parcel crossing, profile top
and PBL closure. [Contracts](../packages/contracts/src/index.ts) owns their
constants. Grid axes and wrap behavior come from the manifest. The sampler plans
the contributing cells; the [numeric block layout](architecture.md#why-these-boundaries-exist)
maps them to one bounded range, including longitude-wrap cases.
