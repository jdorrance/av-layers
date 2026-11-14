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

## Numeric wind map data

Builds opted in via `AV_NUMERIC_WIND=true` publish verified binary wind fields
alongside map rasters (`mapData` on the manifest and retained pointer; non-numeric
builds omit `mapData` and return HTTP `409 product-unavailable` on `/data/...`).
[wind-data.ts](../packages/contracts/src/wind-data.ts) owns the wire contract:

- `GET /v1/models/{model}/runs/{buildId}/data/{frame}` returns a JSON
  `WindFrameDescriptor` (`version: 3`, `tileSize: 16`, `fineTileSize: 64`,
  `levels`, `wind`, `fine`, optional `overview`, and optional canonical base64
  bitsets `windMask` / `fineMask`). When a mask is present, bit `i` (`bytes[i >> 3] & (1 << (i & 7))`)
  marks whether logical row-major tile `i` intersects active coverage; all-outside
  tiles are omitted and compact slot `s` maps to the `s`-th set bit.
- `GET /v1/models/{model}/runs/{buildId}/data/{frame}/{kind}/{tile}` returns raw
  `application/octet-stream` bytes for `kind` in `wind`, `fine`, or
  `overview-{stride}` (`2`, `4`, `8`, `16`). `{tile}` is either a single compact
  slot (`0`) or a contiguous single-page inclusive span (`start-end`, up to `1 MiB`).
  Each page stores up to `512` equal-sized chunks in `{kind}-{page}.bin` paired
  with `512 × 32`-byte SHA-256 digests in `{kind}-{page}.idx`.

Little-endian binary chunk layouts:

- `wind` (`WND2`): 12-byte header (`u32 magic = 0x32444e57`, `u16 version = 1`,
  `u16 levels`, `u32 columns = tileSize²`), followed for each column by a 9-byte
  10 m surface vector (`f32 u`, `f32 v`, `u8 status`) and `levels` ascending
  13-byte upper-air records (`f32 heightMsl`, `f32 u`, `f32 v`, `u8 status`).
- `fine`: `fineTileSize²` 10-byte cells (`f32 terrainM`, `f32 liftMslM`,
  `u8 packedFlags = terrainStatus | (liftStatus << 2) | (outputBit << 4)`,
  `u8 support`).
- `overview-{stride}`: `32 × 32` coarse cells × `12` vertical modes (`surface`,
  fixed AGL heights `20, 100, 300, 600, 1000, 1500, 2000, 3000, 4000, 5000 m`,
  and `lift`) × 9-byte vector (`f32 u`, `f32 v`, `u8 status`, `108` bytes/cell).

## Colour and interpolation

[layers.ts](../packages/contracts/src/layers.ts) defines palette thresholds,
colours, and legend labels, which are snapshotted into each build manifest.
MSL maps colour known no-lift cells at their stored ground elevation, including
at night. AGL maps leave no-lift cells and nonpositive values clear. Unavailable
and outside-domain cells remain clear in both views. Point status distinguishes
these cases; high terrain colours alone do not imply usable height above ground.
Retained builds with older render styles leave no-lift MSL cells clear too.

When all four surrounding grid cells are valid (or `no-usable-lift` on lift
layers), the sampler interpolates bilinearly; if any contributor is missing, it
returns the nearest cell's value and status. Above-ground wind interpolation
renormalizes across valid above-ground native donors when adjacent steep terrain
places a neighbouring donor's lowest level above the target MSL height. See
[science and sampling](science.md) for exact rules.
