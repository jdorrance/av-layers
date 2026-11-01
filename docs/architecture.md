# Architecture

The batch process turns admitted model inputs into immutable display and
sampling artifacts. A read-only Worker serves those artifacts to any client that
pins one build for the duration of a view.

```text
Forecast providers → batch acquisition → science → tiles + numeric pack
                                                   ↓ validate and publish
                                              private R2 bucket
                                                   ↓
                                            read-only API Worker
                                                   ↓
                                   any map or API consumer (preview, apps, plugins)
```

## Workspace map

- [Contracts](../packages/contracts/README.md) owns shared schemas, identifiers,
  palettes, coverage assets and client helpers (`@av/contracts/client`).
- [Forecast](../packages/forecast/README.md) owns pure column calculations and
  scalar sampling. Its callers supply inputs and handle storage.
- [Batch](../apps/batch/README.md) owns provider acquisition, derivation,
  rendering, validation and publication.
- [API](../apps/api/README.md) owns HTTP validation, publication admission,
  bounded reads and caching.
- [Preview](../apps/preview/README.md) owns the standalone MapLibre map and
  point-series interface.
- [Windy plugin](../apps/windy-plugin/README.md) is one optional consumer that
  adapts the shared client helpers to Windy's host map, timestamp store and
  plugin lifecycle.

## Why these boundaries exist

Each layer and forecast frame has a PMTiles archive for display. One numeric
pack stores all frame/layer channels in spatial blocks, with neighboring cells
duplicated at block edges. The Worker reads a point's contributors in one bounded
range, including across longitude wrap. Numeric values and status flags remain
independent of palette colours and display zoom. Rendering and point sampling
share scalar interpolation logic. The [pack implementation](../packages/forecast/src/sample-pack.ts)
owns ordering, offsets and reconstruction; the [capacity module](../apps/batch/src/capacity.ts)
enforces build and point-range budgets.
The [data contract](data.md) defines what those values and statuses mean.

A manifest identifies the artifacts, method, coverage, provenance and expiry of
one build. Publication writes immutable artifacts before admitting the build
through a conditional latest-pointer update. This keeps incomplete uploads out
of discovery and gives concurrent publishers a single commit point. Retention,
rollback and cache details belong to [operations](operations.md).

Request handling reads published data; acquisition and scientific derivation
remain batch responsibilities. Clients discover a build, use its explicit
frames and stop presenting it after expiry. They need no provider credentials
or knowledge of archive internals.

GFS is the integrated build path. See [status](status.md) for evidence and
[roadmap](roadmap.md) for regional coverage, export and serving work.

Trusted [product definitions](../packages/contracts/src/index.ts) own required
frames, layers, grid and native zoom. Batch admission checks resource budgets
before downloading inputs. Adding a product requires a provider and coverage
proof; adding a layer does not require rerunning shared column science. Use
`pnpm capacity` to inspect the current workload and model growth before raising
limits. Deeper display zoom uses client overzoom rather than automatically
expanding the native tile pyramid.

## Alpha contract and extension boundary

Manifest v3 is the only admitted format. Each build snapshots layer labels,
units, vertical/time support, scientific method identifiers, palette edges and
colors, attribution and query limits. Clients and the API read that snapshot;
a later palette/registry edit cannot reinterpret an already published build.
There is one current layer definition and one static production recipe registry.

A recipe separates model family, model configuration and native domain. Its
content hash includes source components, lockfile, recipe configuration and the
coverage identity; Git revision and dirty state are recorded separately. The
provenance sidecar binds the exact build/cycle and source-frame receipts. Raw
provider/GRIB details stop at the adapter. Normalized typed arrays have declared
units, explicit missingness, time windows and a native grid.

The build core accepts that recipe/provider and a verified coverage mask. It
preflights the complete working set, derives related lift outputs once, writes
each channel directly into the final admitted pack, and renders selected layers
together with one bounded encode queue. The official PMTiles writer remains.
No generic task graph, plugin service, format registry or live-model router is
introduced.

Coverage lives at `coverage/{descriptor-sha256}/`: descriptor plus output, halo
and tile bitsets. The descriptor binds geometry, geographic bounds, support
policy and sample layout. Batch writes dependencies before latest publication;
the Worker verifies hashes and resolves/cache-keys by content identity. Regular
latitude/longitude sampling retains its separable path; Lambert uses explicit
projection parameters and bounded prepared mappings. Neither introduces new
forecast physics. See [extension recipes](extensions.md) for future admission.

The public client barrel exposes API, time and presentation helpers from small
modules. MapLibre and Windy retain separate lifecycle controllers. A separate
local-only Worker entrypoint admits the synthetic development product; it is
not reachable through the production registry or Wrangler deployment entrypoint.
