# Extending the project

Follow [development](development.md) for setup and
[architecture](architecture.md) for package ownership.

## Change existing settings

[forecast.json](../packages/contracts/config/forecast.json) owns job and worker
parallelism, per-model zoom, schedules and shard targets. Edit it, run
`pnpm docs:generate`, then `pnpm capacity --model MODEL` and `pnpm verify`.

Edit [gfs.json](../packages/contracts/config/gfs.json) or
[icon-eu.json](../packages/contracts/config/icon-eu.json) for model settings;
[product.ts](../packages/contracts/src/product.ts) validates shared fields.
Physical constants and defaults live in
[`@av/solar`](../packages/solar/README.md),
[`@av/thermodynamics`](../packages/thermodynamics/README.md), and
[`@av/soaring`](../packages/soaring/README.md) and are re-exported into
[method descriptors](../packages/contracts/src/methods.ts).

After changing a grid or coverage policy, regenerate its masks:

```sh
pnpm masks:build --config packages/contracts/config/icon-eu.json
```

Then run `pnpm docs:generate` and rebuild forecast data.

## Add a weather model

1. Add `packages/contracts/config/<model>.json` and its entry in
   [forecast.json](../packages/contracts/config/forecast.json), resolve both through `settings`, call `defineProduct` in
   [products.ts](../packages/contracts/src/products.ts), and include it in
   `PRODUCTS`.
2. Create `apps/batch/src/<model>/` with a `provider.ts` implementing
   [`ResolvableForecastProvider`](../apps/batch/src/provider.ts) (`resolveCycle`,
   `proveInputs`, and `open({ cycle, activeIndices, cacheDir, signal })`). Keep
   downloads, caching, decoding, and unit/interval normalization inside the
   adapter.
3. Register the provider in [providers.ts](../apps/batch/src/providers.ts) keyed
   by `product.source.configurationId`, using dynamic imports so model selection
   stays lightweight. Set `maxLevels` and `retainedGeometryFields` for capacity
   accounting.
4. Add unit and integration tests for decoding, metadata verification, flux/rate
   interval recovery, missingness, and session cleanup.
5. Run `pnpm docs:generate` to update workflow model choices and schedules,
   and record attribution in [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt).

Verify offline and with live upstream data:

```sh
pnpm test packages/forecast/src/inputs.test.ts apps/batch/src/providers.test.ts
pnpm test apps/batch/src/native-build.integration.test.ts apps/batch/src/parallel.test.ts
pnpm capacity --model MODEL
pnpm input:proof --model MODEL --cache-dir .cache/MODEL
pnpm forecast --model MODEL --out output --cache-dir .cache/MODEL \
  --terrain-catalog-ref output/terrain-catalog-ref.json
```

[Development](development.md#build-a-real-forecast) covers catalog access for
configured refinement zones.

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
