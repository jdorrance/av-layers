# `@av/contracts`

Shared Zod schemas, model and layer definitions, grid math, colour palettes, and
browser API client helpers.

## Usage

```ts
import { publishedManifestSchema, type PublishedManifest } from '@av/contracts';

export function parseManifest(json: string): PublishedManifest {
  return publishedManifestSchema.parse(JSON.parse(json));
}
```

Version 3 describes one numeric grid; version 4 adds regional patches.
Version 5 assigns each layer to a native or fine surface with sparse coverage,
terrain identity and bounded sample shards. [publication.ts](src/publication.ts)
owns their schemas, artifact enumeration and layout binding. `manifestSchema`
retains the version-3/version-4 reader; `publishedManifestSchema` admits every
supported version. Native scalar channels declare sample-only delivery;
`renderedLayers` selects map layers. `mapFrameCount` selects the map prefix;
native samples and profiles retain the complete frame axis.

[point-products.ts](src/point-products.ts) owns bounded point batches and native
profile responses. Version-2 provenance indexes reference
bounded frame receipts; retained version-1 receipts stay inline.

`ApiClient` point requests default to the first v5 frame. Select frame pages for
complete timelines; explicit `all` selections retain the serving budgets.
`ApiClient.pointSeries(build, point)` loads and caches scalar samples and native
profiles independently for the pinned point. When the selected frame has map
lift, progress starts after its sample request settles. Profiles merge by frame
ID. `onProgress` reports loading separately from the frame count.
[client-point.ts](src/client-point.ts) owns paging and cancellation.
Point day views use an explicit v5 `mapFrameCount`; older builds retain 24 hours.

[whole-domain-grid.ts](src/whole-domain-grid.ts) derives subdivided grids and
positive-weight native donor support. [sparse-coverage.ts](src/sparse-coverage.ts)
owns block masks and packed offsets; [coverage.ts](src/coverage.ts) binds the
encoded coverage to its grid and validates its halo.

## Entry points

- [`@av/contracts`](src/index.ts): manifest/pointer/sample schemas, `getProduct`,
  grid projections, layer descriptors, palettes, and publication validation.
- [`@av/contracts/client`](src/client.ts): pinned API and raster transport,
  frame matching, tile URL builders, and sample formatting.
- [`@av/contracts/client/dom`](src/client-dom.ts): DOM renderers for legends and
  build diagnostics. Point presentation lives in [windgram](../windgram/README.md).
- [`@av/contracts/refinement`](src/refinement.ts): polygon validation, 1 km Lambert grids,
  and per-layer patch lookup.
- [`@av/contracts/fixture-product`](src/fixture-product.ts): synthetic product
  definition used by `pnpm dev`.

## Configuration

[forecast-windows.ts](src/forecast-windows.ts) owns each model's output window,
minimum useful horizon and frames per compute shard. It derives selected hours,
map end and shard count. [models.json](config/models.json) owns source protocols,
intervals, grids, coverage, capabilities, schedules and parallelism.
[products.ts](src/products.ts) validates the registry and resolves defaults.
Run `pnpm docs:generate` after configuration changes to update workflow schedules
and the reference. `terrainSubdivisionFactor` configures whole-domain lift grids.
[layers.ts](src/layers.ts) defines layer units and palettes,
and [methods.ts](src/methods.ts) defines method descriptors and required inputs.
See [extensions](../../docs/extensions.md) to add a model or layer.

[refinement.json](config/refinement.json) selects research refinement areas.
[planRefinements](src/refinement.ts) builds grids within the source bounds, with
halo cells. Inspect the result with `pnpm refinement --model icon-eu`.

```sh
pnpm test packages/contracts
```
