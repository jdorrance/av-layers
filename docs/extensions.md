# Extending the foundation

The production registry currently admits GFS and the three existing scalar
layers. The examples below exercise extension boundaries with synthetic data.
They do not admit another live model or make a new forecast-skill claim.
Start with [local development](local-development.md), then use the smallest
recipe that proves the intended change.

## Supply existing science from another adapter

The runnable example is
[`normalizedFixtureFrame`](../scripts/fixtures/normalized-provider.ts), used by
both [`dev-fixture.ts`](../scripts/dev-fixture.ts) and the
[native build integration test](../apps/batch/src/native-build.integration.test.ts).
The latter supplies two different grids, frame schedules and layer subsets to
the real build, numeric packing, rendering and validation pipeline.

```sh
pnpm exec vitest run apps/batch/src/native-build.integration.test.ts
pnpm dev:fixture --generate-only
```

1. Implement the small `ForecastProvider`/session interface in
   [`providers.ts`](../apps/batch/src/providers.ts). Keep source discovery,
   download inventories, file encoding and source-specific normalization inside
   that adapter. `open` accepts the active native indices; `acquire(hour)` returns
   a `NormalizedFrame`; `close` releases the session even after failure.
2. Preserve the exact sorted `activeIndices` order and native grid identity.
   Each compact field has one entry per active index. `NormalizedFrame` supplies
   pressure in Pa at the surface, temperature in K, specific humidity in
   kg/kg, geopotential height in metres MSL, upward flux in W/m² and precipitation rate in mm/h. PBL depth is model AGL. Pressure
   levels are explicitly hPa, descending, and common to the columns. Missingness
   has its own byte array for every field and level. Do not convert a missing
   input to a physical zero.
3. Define the meaning of source signs, heights, interval endpoints and averages
   in the adapter's receipt. Match cycle, hour, valid time, profile time, flux
   interval and rain interval to the product. Record source intervals separately
   when temporal differencing or companions are needed. Do not hide an
   accumulation/rate or instantaneous/mean distinction behind a units label.
4. Inject a test-only `ProductDefinition`, mask and provider into `buildForecast`.
   Start with an existing layer subset. Assert analytic values and flags before
   adding a real source. Exercise missing data, invalid intervals, dimension
   disagreement, cancellation and session cleanup.
5. Before production admission, add source rights/provenance, independent source
   decoder checks, a pinned real-input corpus and capacity evidence. Only then
   add the product to the static production registry and publication policy.

`validateNormalizedFrame` checks layout and vertical-axis admission; it is not a
substitute for independent validation of the adapter's physical conversions.
The canonical field definitions and explicit method dependencies live in
[`methods.ts`](../packages/contracts/src/methods.ts). The existing batch column
bridge converts K to °C and Pa to hPa using the same declared constants consumed
by the pure lift kernel. No vector input or implied vector basis is admitted.

## Change a scalar calculation

Keep the current shared lift calculation in one column kernel. A new scalar
quantity should be an explicit pure calculation with an explicit dependency
list, rather than another copy of the acquisition/build pipeline.

- Add the quantity identifier, `LayerSpec`, descriptor metadata and admitted
  palette in [contracts](../packages/contracts/src/index.ts). Specify units,
  vertical reference, temporal support, missing/no-lift behavior and interpolation
  semantics. A new quantity is not just a new color ramp.
- Put the calculation and scientific fixtures in
  [`packages/forecast`](../packages/forecast/README.md). Wire the calculation once
  in [`deriveFrame`](../apps/batch/src/build.ts), then opt into the result through
  a test product's `layers`. The scalar inventory is deliberately closed and
  typed; there is no runtime plugin registry or universal execution graph.
- Add the fixed method definition in
  [`methods.ts`](../packages/contracts/src/methods.ts): required normalized inputs,
  shared outputs, immutable numeric parameters, spatial support and caveats.
  Current lift MSL/AGL layers reference one definition and one evaluation; rain
  references only its normalized rate. `descriptors.methods` stores the selected
  definitions with the build. A parameter change requires a new explicit method
  definition; the science identity hashes both implementation and method snapshot.
  Wire validation checks bounded types and local dependency/output references,
  so retained snapshots remain readable without consulting today's constants or
  keeping the old executable kernel in the serving application.
- Pass the immutable manifest layer descriptor to `sampleCells` and prepared
  sampling. The API already does this. A historical build must retain its own
  value/status semantics and palette after current source code changes.
- Prove independent numeric expectations, missing-input behavior, API sample
  validation and legend/units behavior in the fixture clients. Measure the added
  dependency arrays, output channels, tile count, point range and total working
  set before admitting the quantity.

This milestone does not implement another scalar product. For a harmless
infrastructure rehearsal, change the existing layer/frame subset in the native
integration test rather than inventing a forecast quantity.

## Add geometry or change support and coverage

[`geometry.ts`](../packages/contracts/src/geometry.ts) owns the explicit regular
latitude/longitude and spherical Lambert conformal conic schemas. Native storage
indices are separate from geographic coordinates and public geographic bounds.
The spherical Earth radius, origin, standard parallels, signed grid spacing and
longitude wrapping are part of the immutable geometry. An ellipsoidal source
requires its own implementation and independent control points; do not relabel
it as a spherical grid.

```sh
pnpm exec vitest run packages/contracts/src/geometry.test.ts packages/forecast/src/projected-sampling.test.ts packages/forecast/src/support.test.ts apps/batch/src/native-build.integration.test.ts
```

The checked-in [Lambert fixture](../packages/contracts/src/fixtures/lambert.json)
records independent PROJ control points. Tests cover forward/inverse transforms,
north/south and tangent/secant cones, signed storage steps, vector basis,
convergence and map scale. Prepared projected sampling stores per-coordinate
geometry because latitude and longitude are not separable in projected space.
It is bounded to one tile's quarter-pixel grid; retain the regular-grid fast path.

For a stencil, plan support per primitive dependency. For example:

```ts
import { BILINEAR_SUPPORT, COLUMN_SUPPORT, planFieldSupport, unionSupport } from '@av/forecast';

const column = planFieldSupport(grid, output, BILINEAR_SUPPORT, COLUMN_SUPPORT);
const derivative = planFieldSupport(grid, output, BILINEAR_SUPPORT, [[0, -1], [0, 1]]);
const sharedInput = unionSupport(grid, [column.input, derivative.input]);
```

Here `grid` and `output` are the admitted native geometry and public output
bitset. `derived` is where the derived field must exist for interpolation;
`input` is the primitive support needed to compute it. `composeSupport` adds
offsets across sequential operations on the same grid; `unionSupport` combines
branches that require the same primitive input. Each field may need a different
halo. A universal one-cell or three-cell rule is insufficient.

These offsets are native row/column offsets, not metres. A physical derivative
also needs the correct local metric, signed axis direction and vector basis.
Wrapping is allowed only on an explicitly periodic grid. Missing off-domain
support makes affected targets unavailable; it must not be clamped, extrapolated
or reflected. The support helpers do not calculate any new derivative product.

Keep public output coverage, primitive support, derived support, stored sample
blocks and display-tile coverage distinct. Extra support and block padding must
not make a point publicly covered. Attach coarse geographic bounds to the mask;
west greater than east represents a dateline crossing. Write coverage with
[`writeCoverage`](../apps/batch/src/coverage.ts); its descriptor hash names the
grid, policy and bitsets. Test boundaries, seams, padding, altered hashes and
interpolation parity. Recompute capacity and complete working-set admission
before creating provider sessions.

## Future profiles and WRF: decisions required before implementation

Profiles, profile endpoints, Skew-T/windgram UI, WRF ingestion and execution,
moving nests, convergence, ridge exposure, mountain wave and ensembles remain
deferred. Lambert infrastructure proof is not WRF support.

For profiles, choose a vertical coordinate and datum, pressure representation,
ordering, vector basis, missing/status encoding and per-field error tolerance
before choosing Int16 scales. Account for every field, stored support cell,
padding cell, level, time and byte. Do not use output-cell counts as stored-cell
counts, or omit pressure merely because temperature/height/wind were listed
first. Decide overflow and reserved-value behavior and bound the largest point
read before introducing a binary format. The plan's corrected storage example
and rejected shortcuts are recorded in [the foundation plan](foundation-plan.md).

A future WRF adapter needs independent fixtures for mass versus staggered grids,
destaggering order, perturbation plus base pressure, perturbation potential
temperature, geopotential height, flux signs, accumulated-rain resets and
grid-relative wind rotation. The current normalized pressure-level column
interface does not describe a terrain-following pressure field that varies by
column. Extend that contract explicitly when such an adapter is authorized.
Domain/nest identity, moving geometry, source time support and native terrain
must also be defined before admission. Do not resample to a regular grid merely
to satisfy an existing interface.

## Alpha cutover

The active manifest contract is version 3. There is no compatibility reader for
discarded alpha manifests. Rebuild artifacts and content-addressed coverage;
deploy clients, Worker and publisher that understand the same contract. Verify
the retained manifest, descriptors, provenance, samples and tiles together.
Rollback restores a compatible Worker/client/build set, not an old pointer under
incompatible code. Follow [operations](operations.md) for the publication and
rollback procedure, and keep synthetic fixtures outside that procedure.
