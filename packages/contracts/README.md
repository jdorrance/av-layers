# `@av/contracts`

Shared Zod schemas, model and layer definitions, grid math, and colour palettes.

## Usage

```ts
import { manifestV5Schema, type ManifestV5 } from '@av/contracts/publication';

export function parseManifest(json: string): ManifestV5 {
  return manifestV5Schema.parse(JSON.parse(json));
}
```

Version 5 assigns each layer to a native or fine surface with sparse coverage,
terrain identity and bounded sample shards. [publication.ts](src/publication.ts)
owns the wire schemas, artifact validation and layout binding.
Native scalar channels declare sample-only delivery;
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

- [`@av/contracts/publication`](src/publication.ts): v5 manifests, pointers,
  point samples and provenance. [Regional publication](src/regional-publication.ts)
  reads archived regional controls for evaluation.
- [`@av/contracts/models`](src/products.ts): validated source and build settings.
- [`@av/contracts/model-options`](src/model-options.ts): generated browser choices.
- [`@av/contracts/format`](src/format.ts), [`geometry`](src/geometry.ts) and
  [`layers`](src/layers.ts): numeric limits, grid math and layer definitions.
- [`@av/contracts/refinement`](src/refinement.ts): polygon validation, 1 km Lambert grids,
  and per-layer patch lookup.
- [`@av/contracts/fixture-product`](src/fixture-product.ts): synthetic product
  definition used by `pnpm dev`.

Browser clients use [`@av/client`](../client/README.md).

## Configuration

[models.json](config/models.json) owns source protocols, intervals, grids,
coverage, capabilities, forecast windows and execution. [product.ts](src/product.ts)
derives selected hours, map end, minimum horizon and shard count.
[products.ts](src/products.ts) validates the registry and resolves defaults.
Run `pnpm docs:generate` after configuration changes to update workflow schedules
and the reference. `terrainSubdivisionFactor` configures whole-domain lift grids.
[layers.ts](src/layers.ts) defines ordered layer IDs, descriptors, default
surfaces, and palettes,
and [methods.ts](src/methods.ts) defines method descriptors and required inputs.
See [extensions](../../docs/extensions.md) to add a model or layer.

[refinement.json](config/refinement.json) selects research refinement areas.
[planRefinements](src/refinement.ts) builds grids within the source bounds, with
halo cells. Inspect the result with `pnpm refinement --model icon-eu`.

```sh
pnpm test packages/contracts
```
