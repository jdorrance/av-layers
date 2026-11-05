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
supported version.

[whole-domain-grid.ts](src/whole-domain-grid.ts) derives subdivided grids and
positive-weight native donor support. [sparse-coverage.ts](src/sparse-coverage.ts)
owns block masks and packed offsets; [coverage.ts](src/coverage.ts) binds the
encoded coverage to its grid and validates its halo.

## Entry points

- [`@av/contracts`](src/index.ts): manifest/pointer/sample schemas, `getProduct`,
  grid projections, layer descriptors, and palettes.
- [`@av/contracts/client`](src/client.ts): `ApiClient`, frame matching, tile URL
  builders, and sample formatting.
- [`@av/contracts/client/dom`](src/client-dom.ts): DOM renderers for legends,
  diagnostics, and point sample tables.
- [`@av/contracts/refinement`](src/refinement.ts): polygon validation, 1 km Lambert grids,
  and per-layer patch lookup.
- [`@av/contracts/fixture-product`](src/fixture-product.ts): synthetic product
  definition used by `pnpm dev`.

## Configuration

[forecast.json](config/forecast.json) owns job and worker parallelism, per-model
zoom, schedules and shard targets. [products.ts](src/products.ts) resolves worker
defaults and validates each registered model. Run `pnpm docs:generate` after
editing it to update workflow schedules, model choices and the reference.

[gfs.json](config/gfs.json) and [icon-eu.json](config/icon-eu.json) configure
each model's grid, forecast hours, layers, vertical coordinate, daylight policy,
and coverage mask; [products.ts](src/products.ts) loads them with
`defineProduct`. Coverage masks exclude Africa, Russia, China, Antarctica and
Greenland. `terrainSubdivisionFactor` configures whole-domain lift grids.
[layers.ts](src/layers.ts) defines layer units and palettes,
and [methods.ts](src/methods.ts) defines method descriptors and required inputs.
See [extensions](../../docs/extensions.md) to add a model or layer.

[refinement.json](config/refinement.json) selects refinement areas.
[planRefinements](src/refinement.ts) builds grids within the source bounds, with
halo cells. Inspect the result with `pnpm refinement --model icon-eu`.

```sh
pnpm test packages/contracts
```
