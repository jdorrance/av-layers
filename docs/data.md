# Reading the forecast

Each build packages one model run's map tiles, point samples, and metadata. Tiles
and point queries evaluate the same grids and interpolation rules.

## Layers and missing values

- `usable-lift-msl`: estimated usable thermal top in metres above mean sea
  level.
- `usable-lift-agl`: usable depth in metres above ground. The descriptor names
  `model-AGL` for native model ground or `terrain-AGL` for the prepared surface
  elevation. Current fine grids use Copernicus GLO-90, a digital surface model
  that includes vegetation and buildings.
- `precip-rate`: mean precipitation rate over the frame's trailing interval in
  millimetres per hour.

Each build's manifest descriptors list its available layers and delivery.
[Native fields](../packages/contracts/src/layers.ts) add lift, flux,
surface, cloud, stability and wind samples. Map layers carry palettes; native
scalar channels use point queries.

GFS and RRFS use surface CAPE and valid-time `GUST`. ICON-EU uses mixed-layer
`CAPE_ML` and the 10 m interval maximum `VMAX_10M`. RRFS mean sea-level pressure
uses the Eta reduction (`MSLET`). See the [model registry](../packages/contracts/config/models.json)
for the source fields and levels behind each layer.

Every sample carries a status:

- `valid`: finite numeric value.
- `no-usable-lift`: daytime column solved to no usable lift, or the cell is in
  darkness across the frame's interval and valid time
  (`solarElevation <= minimumSolarElevationDeg`, support `0`). Public MSL value
  is `null`; AGL value is `0`.
- `unavailable`: required inputs are missing or invalid, or the selected surface
  lacks the frame. Value is `null`.
- `outside-domain`: coordinate falls outside the product's coverage mask. Value
  is `null`.

Each layer tracks its own input masks independently, so missing thermal inputs
leave `precip-rate` valid and vice versa. Sample responses also report
`interpolated` and bitmask `support` flags from the contributing grid cells.

## Coverage and resolution

The [configured models](reference.md#configured-models) define coverage,
subdivision factors and tile zooms. Coverage intersects cell footprints with
pinned Natural Earth polygons and includes a separate 1-cell interpolation halo.
Source receipts are emitted by the [native coverage generator](../scripts/masks/build_masks.py)
and [fine coverage generator](../scripts/masks/build_fine_masks.py).

Version-5 manifests assign each layer to one surface. Lift uses the fine
terrain-column surface; weather scalars use the native surface. Each surface
pins its grid, coverage and sample shards. A sample value's `surfaceId` identifies
its grid and ground reference. Output masks select coverage; halo cells supply
boundary contributors. No-lift and unavailable values retain their selected
surface's status. Missing advertised assets fail the request.

ICON-EU's native surface uses the configured regular output grid. Its
[source adapter](../apps/batch/src/split-grib/README.md) selects one triangular-mesh
column for each output cell before terrain refinement and point interpolation.

## Time and retention

- `cycle`: upstream model initialization time (UTC).
- `validTime`: forecast valid time (UTC).
- `intervalStart` / `intervalEnd`: trailing flux and precipitation window (UTC).
- `createdAt` / `ageSeconds`: build creation timestamp and elapsed seconds since
  the build started.

[Model settings](../packages/contracts/config/models.json) own forecast windows
and source intervals.
Current products emit native weather and profiles through the complete
selected horizon, including night. Precipitation retains its trailing interval
at night. `mapFrameCount` selects the tiles and fine-lift
prefix; retained builds may expose later native samples and profiles.
Retained `regional-daylight` builds follow the [daylight selection rule](science.md#input-fields),
including its all-dark fallback.

`/profile` echoes the requested `lat` and `lon` and identifies the nearest
covered native grid cell in `cell`. Each frame's `layers` and `profile` come
from that cell, and `derived` uses those same scalars and levels. `/sample`
and `/samples` evaluate the requested coordinates. The windgram uses these
point samples for map lift. [Point products](../packages/contracts/src/point-products.ts)
owns the wire contract and page budgets.

API freshness and the map notice use the last rendered frame's `validTime`.
The full point forecast uses the complete frame axis. Historical frames remain
viewable until the build's `expiresAt` deadline. See [operations](operations.md)
for publication and expiry rules.

## Colour and interpolation

[layers.ts](../packages/contracts/src/layers.ts) defines palette thresholds,
colours, and legend labels, which are snapshotted into each build manifest. On
lift tiles, `no-usable-lift` and nonpositive AGL values render transparent.

When all four surrounding grid cells are valid (or `no-usable-lift` on lift
layers), the sampler interpolates bilinearly; if any contributor is missing, it
returns the nearest cell's value and status. See
[science and sampling](science.md) for exact rules.
