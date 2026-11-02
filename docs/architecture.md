# Architecture

A batch job downloads weather data, calculates the forecast, and writes files.
The API serves those files to the standalone map and Windy plugin. Each client
uses one completed build until the user reloads it or its data expires.

```text
Source adapter → calculations → tiles + point data → private R2 bucket
                                                         ↓
                                                    API Worker
                                                         ↓
                                              preview / Windy / API clients
```

## Workspace map

- [contracts](../packages/contracts/README.md): model settings, shared schemas,
  grids, layers, palettes, and client helpers.
- [forecast](../packages/forecast/README.md): whole-frame derivation, normalized input
  arrays, interpolation, and sample-pack layout.
- [solar](../packages/solar/README.md): NOAA solar position, sunrise/sunset, and
  separable grid daylight evaluation.
- [thermodynamics](../packages/thermodynamics/README.md): pure dry-air thermodynamics
  and parcel equations.
- [soaring](../packages/soaring/README.md): dry convective parcel crossing, Deardorff
  $w_*$ (`m/s`), Lenschow updraft profile, and configurable sink-rate thresholds (`m/s`).
- [batch](../apps/batch/README.md): downloads, file generation, validation,
  publication, and cleanup.
- [api](../apps/api/README.md): HTTP requests, storage reads, and caching.
- [preview](../apps/preview/README.md): standalone MapLibre map.
- [windy-plugin](../apps/windy-plugin/README.md): Windy's map and time controls.

## Settings have an owner

[GFS settings](../packages/contracts/config/gfs.json) define its grid, forecast
hours, source products and pressure levels, coverage, and freshness rules. The
[NOAA field mapping](../apps/batch/src/noaa/fields.ts) selects the actual input fields.
TypeScript and the Python
mask generator read the same file. The [product registry](../packages/contracts/src/products.ts)
lists available models. A public model ID is separate from its upstream model
family, configuration, and domain.

[Methods](../packages/contracts/src/methods.ts) define calculation parameters and
input units. [Build budgets](../apps/batch/src/capacity.ts) limit memory, tiles,
point data, and build time. [Serving budgets](serving-budgets.md) describe API
limits. [Wrangler settings](../apps/api/wrangler.json) own deployed bucket and
Worker bindings. Node and pnpm versions live in [package.json](../package.json);
the PMTiles version and download checksums live in [pmtiles.json](../apps/batch/pmtiles.json).
Shared dependency versions use the pnpm catalog in
[pnpm-workspace.yaml](../pnpm-workspace.yaml).

## Build and storage

An adapter returns normalized arrays with units, missing-value flags, a grid,
and explicit time intervals. The builder checks the full workload before
opening the source session. Related lift outputs share one calculation. Tile
encoding uses bounded concurrency and shares geometry between a frame's layers.

The hosted workflow plans one source cycle and divides the product's frame list
among at most four independent workers. Each uses the same frame pipeline as a
local sequential build. Private completion receipts bind worker outputs to the
plan, source revision, recipe and coverage. The finalizer checks every group,
interleaves its numeric channels, and validates the complete product before
publication. Whole-product limits apply before partitioning; worker memory
limits apply separately. Elapsed build time includes worker startup and transfers,
while summed worker durations record the work performed.

Each layer and frame has a PMTiles archive. One numeric file holds point data
for all frames and layers in spatial blocks. Block edges include neighboring
cells so a point can be read in one storage range. Colors and display zoom do
not alter the numeric results. Tiles and point results use the same interpolation.

Each build has a manifest containing its files, hashes, layers, method details,
source records, and expiry. Coverage has a separate descriptor and bitsets for
public output, supporting cells, and tiles. Its content hash names the files.
Supporting cells and block padding do not extend public coverage.

Publication uploads and checks every file before changing the latest-build
pointer. That final write uses a storage condition, so concurrent publishers
cannot silently overwrite each other. See [operations](operations.md) for
deployment, retention, and rollback.

## Serving and clients

The API reads completed builds. It checks storage membership and expiry, shares
identical reads, and bounds requests, memory, read sizes, and timeouts. Forecast
downloads and calculations stay in the batch job.

Clients use the selected build's layer names, units, colors, and available times.
They share API, tile-request, and display helpers while keeping their map-specific
lifecycle code separate. A local Worker entry point supplies synthetic data for
development; production uses the live registry.

GFS is the only live model. New models and products remain [deferred](roadmap.md).
The [extension guide](extensions.md) describes the seams to use when adding them.
