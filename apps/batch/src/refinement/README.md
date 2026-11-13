# Forecast refinement

Plans 1 km Lambert grids from the shared
[polygon configuration](../../../../packages/contracts/config/refinement.json).

```sh
pnpm refinement --model icon-eu
pnpm refinement --model gfs --zones /path/to/zones.json
```

Prints each intersecting zone's bounds, grid and terrain array size. `--zones`
selects a local configuration file.

## Evaluation

The [forecast comparison](../comparison/README.md) captures current point and
profile products across fixed sites for matched-cycle provider comparisons.

```sh
pnpm refinement:evaluate --control-manifest PATH --cache-dir PATH --out PATH --frames f021,f024
```

[evaluate.ts](evaluate.ts) verifies v4 regional-patch control hashes, source receipts, coverage,
prepared terrain and numeric packs before replaying saved frames from cache.
`--patch zone-001` selects a patch when several are published. Completed reports
live at `OUT/CONTROL_BUILD_ID/report.json` and are immutable.

Reports compare legacy terrain clearance, native columns, supported-donor
surface-anomaly transfer, and the same transfer with unsupported-valley clearance
fallback. Whole-zone and 15 km Aragats populations include numeric differences,
status/support transitions, donor-ground anomalies, supported weights and matched
images. Controls identify the legacy patch method separately from the native
base method. Runtime and peak RSS are separate from deterministic comparisons.
Validation uses multi-cycle paired observations, support and seam checks, and
resource measurements.

## Grid and terrain inputs

[config.ts](config.ts) selects the model grid and polygon configuration.
[planRefinements](../../../../packages/contracts/src/refinement.ts) validates the
polygons and plans grids within the source bounds. The evaluator loads the
original coverage and prepared DEM from the saved control build.

[`@av/forecast/refinement`](../../../../packages/forecast/src/refinement.ts)
reconstructs terrain columns for MSL and terrain-AGL lift, with same-frame
terrain-clearance fallback for unsupported valleys. See
[science](../../../../docs/science.md#terrain-columns) for the equations.
