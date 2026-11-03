# Reading the forecast

Each build describes a model run, forecast times and coverage. Samples and tiles
share the same fields and sampling rules. Zooming does not add observations;
local detail comes from the grid and method recorded in the build.

## Layers and missing values

- `usable-lift-msl` estimates the usable thermal top in metres above model mean
  sea level.
- `usable-lift-agl` expresses usable depth above ground. Its descriptor names
  the reference: `model-AGL` uses model terrain; `terrain-AGL` uses prepared DEM
  terrain in a refinement patch.
- `precip-rate` is the mean precipitation rate over the frame's advertised
  interval, in millimetres per hour.

GFS publishes all three layers. ICON-EU currently publishes the two lift layers;
its manifest omits precipitation. Clients read each build's layer descriptors.

Every sample includes a status. `valid` carries a finite value.
`no-usable-lift` is emitted when a daytime column solves to no usable lift or
when the cell is outside of daytime across the frame's trailing interval and valid
time (`solarElevation <= minimumSolarElevationDeg`, with support `0`): its public
MSL value is `null` and its AGL value is `0`. `unavailable` means required inputs
are missing or invalid, or—for `precip-rate`—that the cell is outside of
daytime (`solarElevation <= minimumSolarElevationDeg`); `outside-domain` means the
point falls outside published coverage. Both carry `null`, never an invented zero.
Rain has no no-lift status or lift-support flags.

Missingness follows each layer's dependencies. Missing thermal inputs can leave
rain usable, and missing precipitation can leave lift usable. The `interpolated`
field and support flags describe reconstruction, not a new scientific calculation
at that location.

## Coverage and resolution

GFS's `soaring-land-v1` policy includes land and coastal cells between
55°S and 65°N, with a 50 km seaward buffer. It excludes Russia, Antarctica and
Greenland; deserts and inland lakes remain included. High-latitude exclusions
are coverage limits rather than model failures.

ICON-EU's `icon-eu-land-v1` mask covers land and the same coastal buffer
inside its regional grid, from 23.5°W to 62.5°E and 29.5°N to 70.5°N, with the same
country exclusions. ICON-EU is a regional product, so it cannot supply global
forecast coverage.

The mask intersects cell footprints with the source geometry. At model spacing,
coastal and exclusion boundaries can differ from that geometry by roughly a
cell diagonal. Additional halo cells support interpolation without extending
the public domain. Source geometry, hashes and lookup metadata live
in the [coverage source notes](../packages/contracts/coverage/source.json).

The build manifest records grid spacing and display limits. GFS uses its native
quarter-degree sampling and native tile zoom 7. ICON-EU uses DWD's published
0.0625° regular grid and native tile zoom 8. This is a remapped model product.
Higher display zoom does not imply finer forecasts. Version-3 manifests bind the exact grid, Earth radius, bounds,
coverage policy and three coverage bitsets through a content hash. Retained builds
keep their own descriptors rather than depending on the current registry.

Version-4 manifests add internal refinement patches to the same model. Each
patch has its own grid, output mask, supported layers and method descriptors;
it inherits the build's times. Polygon and output-mask membership select a
patch before reading values. A no-lift or unavailable fine value does not reveal
the coarse value underneath. Halos supply interpolation support without
enlarging ownership. Missing advertised patch assets are publication errors.

```mermaid
flowchart LR
  B[Model build and timeline] --> N[Base grid]
  B --> P[Polygon patches]
  N --> S[Choose grid by layer and coverage]
  P --> S
  S --> M[Composited map tiles]
  S --> Q[Point values with patchId]
```

An optional `patchId` on a point value identifies its grid, method and ground
reference. A request can combine base MSL or precipitation with refined AGL.
Terrain detail does not by itself establish finer atmospheric prediction.

## Time and retention

`cycle` is the upstream initialization time. `validTime` is the forecast endpoint;
`intervalStart` and `intervalEnd` describe the frame's trailing interval. Fluxes
use that interval, as does precipitation when published. All are UTC.
`createdAt` describes the build, and API `ageSeconds` measures time since that
build began, not time since the model initialized.

Both configured products have hourly candidate endpoints from +1 through +24
hours. These use hourly source fields and recovered interval fluxes; they are
not temporal interpolation between coarser forecasts. ICON-EU omits regional
nighttime frames before acquisition, while retaining a frame when any covered
output cell has daylight at its interval start, midpoint or end. A preceding
hour's flux companion can still be downloaded to recover a retained hour. GFS
keeps all candidate hours. Individual nighttime cells retain the status behavior
described above in either model.

`expiresAt` controls retention and serving eligibility. It does not extend the
forecast horizon: a retained build may contain only past forecast times.
Frame times establish whether a retained forecast covers the present; HTTP
success does not. The clients show a visible notice when the final forecast time
has passed, while allowing historical frames to remain viewable until retention
expires. [Operations](operations.md) explains publication and expiry.

## Colour and interpolation

The [palette definitions](../packages/contracts/src/layers.ts) supply thresholds,
colours and legend labels when a build is created. The immutable manifest then
records them for its samples, legend and clients. Lift uses observed XC MSL colours; reusing those
colours for AGL is a product choice. Rain's palette remains provisional.

Tiles make physical no-lift transparent on both lift layers;
nonpositive AGL values are also transparent. The manifest's `tool.liftRenderStyle`
identifies the rendering style, and the API legend reflects that build's descriptors.
These display choices do not change the numeric statuses or values described above.

Known neighbours interpolate continuously, including physical no-lift cells.
Missing neighbours trigger a nearest-cell result rather than a search for
better-looking data. Tile edges blend subpixel colours and transparency, so a
pixel need not match one legend swatch. Transparency alone cannot distinguish
clear rain or no usable lift from missing or excluded data. Numeric samples
provide that distinction.
The exact rules are in [science and sampling](science.md).
