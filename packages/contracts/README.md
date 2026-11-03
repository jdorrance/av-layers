# `@av/contracts`

Shared forecast types, JSON validation, model settings, palettes and API client
helpers.

## Parse forecast metadata

```ts
import { manifestSchema, type Manifest } from '@av/contracts';

export function parseManifest(json: string): Manifest {
  return manifestSchema.parse(JSON.parse(json));
}
```

`manifestSchema.parse` returns a typed manifest or throws a validation error.
A manifest lists the build's layers, frame times, grid, files and display
settings. Use its `layers` and `frames` to populate a forecast viewer.

## Imports

- `@av/contracts`: types and schemas, model lookup with `getProduct`, grid
  geometry, layer definitions and palettes.
- [`@av/contracts/client`](src/client.ts): `ApiClient`, forecast time selection,
  tile requests, legends and point-result helpers.
- [`@av/contracts/client/dom`](src/client-dom.ts): shared map controls.
- [`@av/contracts/fixture-product`](src/fixture-product.ts): the synthetic product
  used by `pnpm dev`.

## Model and display settings

[GFS](config/gfs.json) and [ICON-EU](config/icon-eu.json) JSON files set each model's
grid, forecast hours, layers and coverage. [products.ts](src/products.ts) loads
them with `defineProduct` and provides the model registry.

To change a layer's label, units or colours, edit [layers.ts](src/layers.ts).
[methods.ts](src/methods.ts) describes its calculation inputs and imports the
numerical defaults from the science packages. Builds save these settings in
their manifests, so previously published forecasts retain their original labels
and methods.

Lift method IDs distinguish shared isobaric pressure levels from per-column
model-level pressures. `createProductDescriptors` selects the matching method
and layer references; retained manifests use their embedded descriptors.

These workspace packages export TypeScript directly; each app bundles the code
it imports. See [extensions](../../docs/extensions.md) for adding a model or layer.

## Refinement zones

[refinement.json](config/refinement.json) contains GeoJSON polygon features with
unique string IDs and empty properties. Add a `Polygon` or `MultiPolygon` in
longitude/latitude coordinates; close each ring by repeating its first position.
Inner rings are holes. Zones and components must not overlap or touch.

[refinement.ts](src/refinement.ts) validates the configuration and plans a bounded
Lambert grid at shared 1,000 m projected spacing, with the caller's halo. Planning
clips ownership to the source's admitted bounds and native grid-center extent;
holes remain excluded. Its returned source bounds also constrain later weather
interpolation. Grid halos are computational support, not published coverage.

The planner admits at most 16 features, 256 positions per ring, 1,024 total positions, 20 degrees per
axis per feature, and latitudes within ±80°. Split dateline-crossing polygons;
crossing edges and wrapped source bounds are rejected. The existing grid-cell
budget applies to the sum of all planned grids, including their halos. Planning
does not allocate forecast fields or change a published forecast.

Run tests from the repository root:

```sh
pnpm test packages/contracts
```
