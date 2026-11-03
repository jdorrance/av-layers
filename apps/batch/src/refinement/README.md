# Forecast refinement

Plans 1 km Lambert grids from the shared
[polygon configuration](../../../../packages/contracts/config/refinement.json).

```sh
pnpm refinement --model icon-eu
pnpm refinement --model gfs --zones /path/to/zones.json
```

Prints each intersecting zone's bounds, grid and terrain array size. `--zones`
selects a local configuration file.

[config.ts](config.ts) resolves the shared configuration for a product.
[planRefinements](../../../../packages/contracts/src/refinement.ts) validates the
polygons and builds grids within the source bounds, with halo cells.
