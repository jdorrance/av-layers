# Reading the forecast

Each build packages one model run's map tiles, point samples, and metadata. Tiles
and point queries evaluate the same grids and interpolation rules.

## Layers and missing values

- `usable-lift-msl`: estimated usable thermal top in metres above mean sea
  level.
- `usable-lift-agl`: usable depth in metres above ground. The descriptor names
  `model-AGL` for model terrain or `terrain-AGL` for prepared DEM terrain.
- `precip-rate`: mean precipitation rate over the frame's trailing interval in
  millimetres per hour.

Each build's manifest descriptors list its available layers and delivery.
[Native fields](../packages/contracts/src/native-layers.ts) add lift, flux,
surface, cloud, stability and wind samples. Map layers carry palettes; native
scalar channels use point queries.

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

Retained version-3 builds use one grid. Version-4 builds add polygon patches with
`patchId`, independent coverage and methods. Both formats keep their existing
sampling behavior; [regional refinement](../apps/batch/src/refinement/README.md)
owns their evaluation tooling.

## Time and retention

- `cycle`: upstream model initialization time (UTC).
- `validTime`: forecast valid time (UTC).
- `intervalStart` / `intervalEnd`: trailing flux and precipitation window (UTC).
- `createdAt` / `ageSeconds`: build creation timestamp and elapsed seconds since
  the build started.

[Model settings](../packages/contracts/config/models.json) select hours and source
intervals. Current products emit native weather and profiles through the complete
selected horizon, including night. Precipitation retains its trailing interval
at night. `mapFrameCount` limits tiles and fine lift to the first 24 hours.
Retained `regional-daylight` builds omit fully dark frames according to their
declared method.

Point profiles select the nearest covered native cell and retain every selected
vertical level. Temperature and height remain usable when optional humidity or
wind fields are absent. Responses report the selected cell, model terrain,
statuses and nullable diagnostics; [point-products.ts](../packages/contracts/src/point-products.ts)
owns the wire contract. Page explicit frame and field selections within its
request budgets.

`expiresAt` sets the 7-day retention deadline. Clients display a notice once
`now` passes the last frame's `validTime` while keeping historical frames
viewable until `expiresAt`. See [operations](operations.md) for publication and
expiry rules.

## Colour and interpolation

[layers.ts](../packages/contracts/src/layers.ts) defines palette thresholds,
colours, and legend labels, which are snapshotted into each build manifest. On
lift tiles, `no-usable-lift` and nonpositive AGL values render transparent.

When all four surrounding grid cells are valid (or `no-usable-lift` on lift
layers), the sampler interpolates bilinearly; if any contributor is missing, it
returns the nearest cell's value and status. See
[science and sampling](science.md) for exact rules.
