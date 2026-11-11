# Extending the project

Follow [development](development.md) for setup and
[architecture](architecture.md) for package ownership.

## Configure a model

[models.json](../packages/contracts/config/models.json) owns each model's source
profile, grid, coverage, capabilities, schedule and zoom, with
shared job and worker defaults. Model parallelism is its fixed job cap; the sum
must fit the shared job budget. Set its window and frames per shard in
[forecast-windows.ts](../packages/contracts/src/forecast-windows.ts), then run:

```sh
pnpm docs:generate
pnpm capacity --model MODEL
pnpm verify
```

Adding a model with an existing source protocol requires a registry entry and
window settings. Choose its URL template, fields, grid and coverage in the registry.
After changing a grid or coverage policy, generate its native and fine masks:

```sh
pnpm masks:build --model MODEL
uv run --python 3.12 --with shapely==2.1.2 --with pyproj==3.7.2 --with pyshp==2.3.1 \
  python scripts/masks/build_fine_masks.py --model MODEL
```

The hosted workflow prepares its terrain cache. Record source attribution in
[THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt), then verify live acquisition:

```sh
pnpm input:proof --model MODEL --cache-dir .cache/MODEL
```

## Add a source protocol

The [provider registry](../apps/batch/src/providers.ts) binds model settings to
configured [indexed GRIB](../apps/batch/src/indexed-grib/README.md) or
[split GRIB](../apps/batch/src/split-grib/README.md) factories. A new source format
adds a factory implementing
[ResolvableForecastProvider](../apps/batch/src/provider.ts) and one protocol entry
in that registry. Keep source metadata validation, downloads, decoding, interval
recovery and resource accounting inside the adapter. Test its real encoded data,
normalization and session cleanup.

Physical constants live in [`@av/solar`](../packages/solar/README.md),
[`@av/thermodynamics`](../packages/thermodynamics/README.md), and
[`@av/soaring`](../packages/soaring/README.md); manifests bind their
[method descriptors](../packages/contracts/src/methods.ts).

### Adapter output

Return a [`NormalizedFrame`](../packages/forecast/src/inputs.ts) ordered by
`activeIndices`:

- Units: surface pressure in `Pa`, temperatures in `K`, specific humidity in
  `kg/kg`, terrain and profile heights in `m` MSL, upward
  heat fluxes in `W/m²`, and optional precipitation rate in `mm/h`.
- Vertical coordinate: descending shared `pressureLevelsHpa` for `IsobaricFrame`,
  or per-column `pressurePa` + `missing.pressure` for `ModelLevelFrame`, ordered
  from lowest to highest altitude.
- Intervals: populate `intervals` and use
  [`@av/forecast/intervals`](../packages/forecast/src/intervals.ts) to recover
  trailing means or rates from cumulative source windows.

## Add a scalar calculation

1. Add the layer ID to `LAYER_IDS` in
   [product.ts](../packages/contracts/src/product.ts) and define its descriptor
   and palette in [layers.ts](../packages/contracts/src/layers.ts).
2. Declare its required inputs and parameters in
   [methods.ts](../packages/contracts/src/methods.ts), extending
   [inputs.ts](../packages/forecast/src/inputs.ts) if new fields are needed.
3. Implement the math in the domain package, map statuses in
   [science.ts](../packages/forecast/src/science.ts), and wire the layer into
   [frame.ts](../packages/forecast/src/frame.ts).
4. Enable the layer in each model config that publishes it, check
   [capacity](../apps/batch/src/capacity.ts) and
   [serving budgets](serving-budgets.md), and run `pnpm docs:generate` and
   `pnpm verify`.

## Add a grid or neighboring-cell calculation

[geometry.ts](../packages/contracts/src/geometry.ts) implements `regular-latlon`
and spherical `lambert-conformal` projections; test new projections against PROJ
control points. [support.ts](../packages/forecast/src/support.ts) resolves
neighboring cells for stencil operations, and
[coverage.ts](../apps/batch/src/coverage.ts) separates public output cells from
halo cells. Finish with `pnpm docs:generate` and `pnpm verify`.
