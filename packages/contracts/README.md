# `@av/contracts`

Shared Zod schemas, model and layer definitions, grid math, colour palettes, and
browser API client helpers.

## Usage

```ts
import { manifestSchema, type Manifest } from '@av/contracts';

export function parseManifest(json: string): Manifest {
  return manifestSchema.parse(JSON.parse(json));
}
```

Version 3 describes one numeric grid. Version 4 adds internal patches under the
same model, build and frame times. `forecastGrids` visits every grid;
`forecastObjects` lists their numeric packs and one composited tile archive per
frame/layer. `validateArtifactRecords` checks manifest references;
`assertCoverageBinding` checks each loaded mask against its grid.

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

[gfs.json](config/gfs.json) and [icon-eu.json](config/icon-eu.json) configure
each model's grid, forecast hours, layers, vertical coordinate, daylight policy,
and coverage mask; [products.ts](src/products.ts) loads them with
`defineProduct`. [layers.ts](src/layers.ts) defines layer units and palettes,
and [methods.ts](src/methods.ts) defines method descriptors and required inputs.
See [extensions](../../docs/extensions.md) to add a model or layer.

[refinement.json](config/refinement.json) selects refinement areas.
[planRefinements](src/refinement.ts) builds grids within the source bounds, with
halo cells. Inspect the result with `pnpm refinement --model icon-eu`.

```sh
pnpm test packages/contracts
```
