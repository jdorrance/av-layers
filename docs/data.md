# Reading the forecast

Each build describes a model run, forecast times and coverage. Samples and tiles
share the same fields and sampling rules. Zooming does not add observations or
resolve local terrain.

## Layers and missing values

- `usable-lift-msl` estimates the usable thermal top in metres above model mean
  sea level.
- `usable-lift-agl` expresses that same top in metres above model ground. It
  subtracts the terrain used by the solver, without a high-resolution DEM correction.
- `precip-rate` is the mean precipitation rate over the frame's advertised
  interval, in millimetres per hour.

Every sample includes a status. `valid` carries a finite value.
`no-usable-lift` is a physical result: its public MSL value is `null` and its
AGL value is `0`. `unavailable` means required inputs are missing or inadmissible;
`outside-domain` means the point falls outside published coverage. Both carry
`null`, never an invented zero. Rain has no no-lift status or lift-support flags.

Missingness follows each layer's dependencies. Missing thermal inputs can leave
rain usable, and missing precipitation can leave lift usable. The `interpolated`
field and support flags describe reconstruction, not a new scientific calculation
at that location.

## Coverage and resolution

The `soaring-land-v1` policy includes admitted land and coastal cells between
55°S and 65°N, with a 50 km seaward buffer. It excludes Russia, Antarctica and
Greenland; deserts and inland lakes remain included. High-latitude exclusions
are coverage limits rather than model failures.

The mask intersects cell footprints with the source geometry. At model spacing,
coastal and exclusion boundaries can differ from that geometry by roughly a
cell diagonal. Additional halo cells support interpolation without extending
the public domain. Source geometry, hashes and lookup metadata live
in the [coverage manifest](../packages/contracts/coverage/manifest.json).

The build manifest owns grid spacing and display limits. GFS uses its native
quarter-degree sampling; higher display zoom does not imply finer forecasts.
Current model availability and integration evidence are in [status](status.md).

## Time and retention

`cycle` is the upstream initialization time. `validTime` is the forecast endpoint;
`intervalStart` and `intervalEnd` describe the precipitation interval. All are UTC.
`createdAt` describes the build, and API `ageSeconds` measures time since that
build began, not time since the model initialized.

`expiresAt` controls retention and serving eligibility. It does not extend the
forecast horizon: a retained build may contain only past forecast times.
Frame times establish whether a retained forecast covers the present; HTTP
success does not. The clients show a visible notice when the final forecast time
has passed, while allowing historical frames to remain viewable until retention
expires. [Operations](operations.md) explains publication and expiry.

## Colour and interpolation

The [palette registry](../packages/contracts/src/index.ts) owns thresholds,
colours and legend labels. Lift uses observed XC MSL colours; reusing those
colours for AGL is a product choice. Rain's palette remains provisional.

Newly rendered tiles make physical no-lift transparent on both lift layers;
nonpositive AGL values are also transparent. The manifest's `tool.liftRenderStyle`
identifies the rendering style. Previously built immutable tiles retain their
original rendering, and the expanded API legend reflects that build's style.
These display choices do not change the numeric statuses or values described above.

Known neighbours interpolate continuously, including physical no-lift cells.
Missing neighbours trigger a nearest-cell result rather than a search for
better-looking data. Tile edges blend subpixel colours and transparency, so a
pixel need not match one legend swatch. Transparency alone cannot distinguish
clear rain or no usable lift from missing or excluded data. Numeric samples
provide that distinction.
The exact rules are in [science and sampling](science.md).
