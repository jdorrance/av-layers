# Forecast refinement

The [zone configuration](../../../../packages/contracts/config/refinement.json)
is a GeoJSON feature collection. Add a polygon to select another area; grid
geometry comes from the shared planner, not from model-specific configuration.

Inspect the grids for either weather source without downloading data:

```sh
pnpm refinement --model icon-eu
pnpm refinement --model gfs --zones /path/to/zones.json
```

The command prints each intersecting zone's bounds, grid and terrain array size.
`--zones` inspects a different configuration without changing the checked-in file.
The source model's coverage and native interpolation support limit each plan.

[config.ts](config.ts) resolves the shared configuration for a product.
The pure [polygon planner](../../../../packages/contracts/src/refinement.ts)
owns geometry, admission and deterministic grid placement. Neither reads a DEM
or acquires weather.

[prepare.ts](prepare.ts) prepares the forecast inputs. Each output cell lies
inside its polygon and the base forecast coverage. A one-cell halo supplies
interpolation support. The base and fine grids share the existing aggregate
cell budget; empty owned areas need no terrain reads.

Preparation reads one pinned catalog, reuses or creates elevations on each grid,
and stages the verified arrays beside the coverage files. The build plan stores
their complete immutable references. Workers load those local files and verify
their geometry, coverage and checksums without resolving a catalog or downloading
source DEMs. Changing polygon ownership while retaining the same grid reuses
the elevation preparation.
