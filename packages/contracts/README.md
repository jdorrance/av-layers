# Shared types and API helpers

`@av/contracts` contains the TypeScript types, validation rules, grid definitions,
and palettes used by the batch job, API, and map clients.

Follow the [root setup instructions](../../README.md#quick-start), then run from
the repository root:

```sh
pnpm test packages/contracts
pnpm verify
```

This package exports TypeScript directly; it has no separate build step.

Entry points:

- `@av/contracts`: forecast definitions, validation, grids, and palettes.
- `@av/contracts/client`: API requests, tile requests, times, legends, and point results.
- `@av/contracts/fixture-product`: generated test data for local development.

Useful files:

- [src/index.ts](src/index.ts): public types and exports.
- [src/methods.ts](src/methods.ts): input fields and calculation parameters.
- [src/geometry.ts](src/geometry.ts): grid coordinates and map projections.
- [src/client.ts](src/client.ts): client helper exports.

GFS is the only supported live model. Each forecast build includes its own layer
names, units, colors, and source-data details so clients can display that build
consistently. See [the data guide](../../docs/data.md).
