# Architecture

The batch process turns admitted model inputs into immutable display and
sampling artifacts. A read-only Worker serves those artifacts to any client that
pins one build for the duration of a view.

```text
Forecast providers → batch acquisition → science → tiles + numeric arrays
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

Each layer and forecast frame has a PMTiles archive for display and a numeric
array for sampling. Archives group tiles into a manageable publication unit;
the Worker extracts requested tiles through range reads. Separate numeric
arrays preserve scalar values and status flags independently of palette colours
or display zoom. Rendering and point sampling share scalar interpolation logic.
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
