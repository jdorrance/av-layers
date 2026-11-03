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

[prepare.ts](prepare.ts) intersects each polygon with base coverage and adds a
one-cell halo. It prepares DEM elevations from a pinned catalog and stages masks
and arrays with the build plan. Workers verify and read those files locally.
[Build budgets](../capacity.ts) include the base and fine grids.

[`@av/forecast/refinement`](../../../../packages/forecast/src/refinement.ts)
calculates terrain-referenced AGL beneath the native lift ceiling. See
[science](../../../../docs/science.md#terrain-clearance) for the method.
