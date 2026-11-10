# `@av/contracts`

Shared Zod schemas, model and layer definitions, grid math, and colour palettes.

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
owns their schemas, artifact validation and layout binding. `manifestSchema`
retains the version-3/version-4 reader; `publishedManifestSchema` admits every
supported version. Native scalar channels declare sample-only delivery;
`renderedLayers` selects map layers. `mapFrameCount` selects the map prefix;
native samples and profiles retain the complete frame axis.

[point-products.ts](src/point-products.ts) owns bounded point batches and native
profile responses. Version-2 provenance indexes reference
bounded frame receipts; retained version-1 receipts stay inline.

[whole-domain-grid.ts](src/whole-domain-grid.ts) derives subdivided grids and
positive-weight native donor support. [sparse-coverage.ts](src/sparse-coverage.ts)
owns block masks and packed offsets; [coverage.ts](src/coverage.ts) binds the
encoded coverage to its grid and validates its halo.

## Entry points

- [`@av/contracts`](src/index.ts): manifest/pointer/sample schemas, `getProduct`,
  grid projections, layer descriptors, palettes, and publication validation.
- [`@av/contracts/refinement`](src/refinement.ts): polygon validation, 1 km Lambert grids,
  and per-layer patch lookup.
- [`@av/contracts/fixture-product`](src/fixture-product.ts): synthetic product
  definition used by `pnpm dev`.

Browser clients use [`@av/client`](../client/README.md).

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
