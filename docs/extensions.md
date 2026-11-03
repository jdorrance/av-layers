# Extending the project

Follow [development](development.md) for setup and
[architecture](architecture.md) to find the relevant package. GFS and ICON-EU
are examples of two sources feeding the same forecast, rendering, and serving
code. Start new source work with small synthetic frames, then check real input
files before building a full forecast.

## Change existing settings

Edit [gfs.json](../packages/contracts/config/gfs.json) or
[icon-eu.json](../packages/contracts/config/icon-eu.json) for model settings.
[product.ts](../packages/contracts/src/product.ts) validates the shared fields;
the source adapter reads any source-specific settings. Numerical defaults live
in the relevant [solar](../packages/solar/README.md),
[thermodynamics](../packages/thermodynamics/README.md), or
[soaring](../packages/soaring/README.md) package and are imported into the
published [method descriptors](../packages/contracts/src/methods.ts).
For numerical experiments, call `deriveFrame` or the math packages directly.
Builds use the recorded method defaults; their only calculation option is the
daylight switch used by the synthetic development fixture.

After a grid or coverage change, regenerate its masks. For example:

```sh
pnpm masks:build --config packages/contracts/config/icon-eu.json
```

The [generator](../scripts/masks/build_masks.py) currently handles the GFS and
ICON-EU coverage policies on regular latitude/longitude grids. Add geographic
regression probes when adding a policy; another grid layout needs a matching
generator. Build fresh forecast files after changing coverage, calculations,
layers, or timing, and refresh generated documentation with `pnpm docs:generate`.

## Add a weather model

1. Add a JSON file under `packages/contracts/config/`, call `defineProduct` in
   [products.ts](../packages/contracts/src/products.ts), and include it in
   `PRODUCTS`. Set the grid, forecast hours, layer subset, vertical coordinate,
   daylight policy, and coverage paths. `modelId` is the public URL/catalog name;
   `source` identifies the upstream model, configuration, and domain.
2. Add an adapter directory under `apps/batch/src/`, using
   [gfs](../apps/batch/src/gfs/README.md) or
   [icon](../apps/batch/src/icon/README.md) as a reference. Implement its local
   `provider.ts` using [ResolvableForecastProvider](../apps/batch/src/provider.ts):
   cycle discovery, input proof, and a session with `acquire(hour)` and `close()`.
   Keep downloads, caching, decoding, field selection, and unit/time conversion
   together in the adapter. The caller acquires frames sequentially and closes
   the session in `finally`.
3. Register that provider in [providers.ts](../apps/batch/src/providers.ts), keyed
   by the source configuration. Keep lazy imports for discovery, proof, and
   acquisition inside the adapter so selecting a model does not load decoders.
   Set `maxLevels` and `retainedGeometryFields` to include any cached terrain or
   height arrays in the memory estimate.
4. Keep provider-loading tests, decoder fixtures, and acquisition tests in the
   adapter directory. Compare representative fields against an independent
   decoder, including units, flux signs, source time
   windows, grid order, and missing values. Exercise bad dimensions, invalid
   intervals, masked pressure, cancellation, and session cleanup.
5. Run synthetic serial and parallel builds, then the real input proof and
   forecast commands below. Measure cold/warm runtime and peak RSS on the
   intended runner before publishing. Check the resulting tiles and point
   values through the API and both clients using [operations](operations.md).

Run from the repository root, replacing `MODEL` with the registered ID:

```sh
pnpm test packages/forecast/src/inputs.test.ts apps/batch/src/providers.test.ts
pnpm test apps/batch/src/native-build.integration.test.ts apps/batch/src/parallel.test.ts
pnpm capacity --model MODEL
pnpm input:proof --model MODEL --cache-dir .cache/MODEL
pnpm forecast --model MODEL --out output --cache-dir .cache/MODEL
```

The first three commands are offline. The proof and forecast download weather
data. [capacity.ts](../apps/batch/src/capacity.ts) defines build limits; use
measurements before raising them. Record source licensing and attribution in
[THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt). The scheduled workflow's
`all` selection expands from the product registry. Update the static GitHub
model dropdowns in forecast, health, and maintenance workflows when registering
a model; [workflow tests](../scripts/workflow-models.test.ts) check them against
the registry. The reusable model workflow and hour batching need no model-specific
branches. Registration on main also enables scheduled production builds; collect
local real-input evidence first, then record staging and production run results.

### Adapter output

Return a [NormalizedFrame](../packages/forecast/src/inputs.ts) with cells in the
exact requested `activeIndices` order. Surface pressure is Pa, temperatures are
K, specific humidity is kg/kg, terrain and profile heights are metres MSL, PBL
depth is metres above model terrain, and surface fluxes are upward W/m². Keep
missing values explicitly masked.

Use one pressure representation: a strictly descending shared hPa axis for
`IsobaricFrame`, or per-column Pa arrays and pressure masks for `ModelLevelFrame`.
Order height/temperature levels from lowest to highest after source conversion.
Precipitation arrays, masks, and intervals are needed when the product includes
`precip-rate`. [Method definitions](../packages/contracts/src/methods.ts) describe
each normalized field.

Supply the actual profile time and source/derived interval windows. The shared
[interval helpers](../packages/forecast/src/intervals.ts) recover trailing means
and rates from validated source windows. A parallel worker can begin partway
through the forecast, so its adapter must fetch earlier companion records when
needed. Hourly output needs hourly source fields; temporal interpolation is not
implemented.

Use the [synthetic provider](../scripts/fixtures/normalized-provider.ts) and
[native-grid integration test](../apps/batch/src/native-build.integration.test.ts)
to exercise the full build with small inputs. These tests cover different grids,
vertical representations, frame spacing, and layer subsets without adding test
models to the production registry.

## Add a scalar calculation

1. Add its ID to `LAYER_IDS` in
   [product.ts](../packages/contracts/src/product.ts). Define its units, vertical
   reference, time interval, missing-value behavior, palette, and interpolation
   settings in [layers.ts](../packages/contracts/src/layers.ts).
2. Add the method's required inputs and parameters in
   [methods.ts](../packages/contracts/src/methods.ts). Extend
   [inputs.ts](../packages/forecast/src/inputs.ts) and the adapters if new input
   fields are needed. Give a changed scientific method its own identifier.
3. Implement equations in the relevant pure math package, translate results and
   status flags in [science.ts](../packages/forecast/src/science.ts), and wire the
   layer into [frame.ts](../packages/forecast/src/frame.ts). Share calculations
   between related outputs, as the two lift layers do.
4. Select the layer in each model JSON that will publish it. Test independent
   expected values and missing-data cases, then verify point results, tiles,
   and legends with a synthetic build.

Recheck build capacity and [serving budgets](serving-budgets.md) for the extra
input arrays, numeric channels, tiles, and point-read size. Builds store their
method and display definitions, so existing files retain their original labels
and meaning.

## Add a grid or neighboring-cell calculation

[geometry.ts](../packages/contracts/src/geometry.ts) supports regular
latitude/longitude and spherical Lambert conformal grids. New geometry needs
independent coordinate fixtures, including the Earth model, signed axes, and
longitude wrapping. The existing
[Lambert fixture](../packages/contracts/src/fixtures/lambert.json) uses PROJ
control points.

[support.ts](../packages/forecast/src/support.ts) selects neighboring cells for
calculations. A physical derivative also needs local distances and the correct
vector basis; cell offsets alone are insufficient. Missing off-domain support
makes the result unavailable. Keep calculation neighbors and stored block
padding separate from public coverage in
[coverage.ts](../apps/batch/src/coverage.ts). Test boundaries, seams, and agreement
between tile and point sampling.

Finish with `pnpm docs:generate` and `pnpm verify`. Format changes need fresh data
and matching publisher, API, and client deployments; follow
[operations](operations.md) for rollout and rollback. Profiles, additional
diagnostics, and other future products are tracked in [the roadmap](roadmap.md).
