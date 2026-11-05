# `@av/soaring`

Calculates dry convective boundary-layer depth, Deardorff thermal velocity
($w_*$), and usable lift depth from a vertical temperature profile and surface
heat fluxes.

## Usage

```ts
import { deriveLift, type ColumnInput } from '@av/soaring';

const column: ColumnInput = {
  terrainM: 500,
  surfaceTemperatureC: 25,
  surfacePressureHpa: 950,
  humidity: { specificHumidityKgKg: 0.007 },
  sensibleHeatFluxWm2: 100,
  latentHeatFluxWm2: 20,
  levels: [
    { heightM: 700, temperatureC: 22.85 },
    { heightM: 1300, temperatureC: 16.95 },
    { heightM: 1900, temperatureC: 11.25 }
  ]
};

const lift = deriveLift(column, column.levels.length, { sinkRateMps: 1.2 });
if (lift.status === 'valid') {
  console.log(lift.usableDepthM); // metres AGL
}
```

Inputs use `°C` for temperature, `hPa` for surface pressure, upward-positive
`W/m²` for fluxes, and ascending `m` MSL for `levels` (reading the first `count`
elements of `levels`). Optional `surfaceEnvironmentTemperatureC` anchors the
environment at `terrainM`; omission retains native lowest-layer extrapolation.

`ReconstructedProfileWorkspace` snapshots and validates native donors before
merging their temperature profiles. Its admitted synthetic extensions use the
bridge mode and height bound supplied to `reconstruct`. `reset` invalidates the
current reconstruction and donor cache; each successful reconstruction owns the
profile consumed by `solve`. Native observation checks remain in
[column.ts](src/column.ts).

## Return value

`deriveLift` returns `{ status, depthM, thermalVelocityMps, usableDepthM, branch }`:

- `valid`: `usableDepthM > 0` for the configured `sinkRateMps`.
- `no-lift`: `usableDepthM === 0`.
- `unavailable`: missing or invalid inputs; numeric fields are `null`.

`branch` distinguishes resolved parcel crossings, unresolved profile caps,
surface-stable columns, and non-convective columns.

`deriveNativeColumnDiagnostics(input, count)` retains dry depth and positive
thermal velocity below the map sink threshold. Native levels ascend in metres
MSL; wind components are Earth-relative m/s. It returns independent surface LCL,
pressure-mass mixed-layer LCL and height-integrated boundary-layer vectors.
Missing moisture or wind inside an integration layer leaves that integral null.
The selected layer top requires a complete upper bracket; known zero depth uses
the surface. BL winds integrate from model ground with the 10 m vector anchored
there, following Windgrams V2. Native model PBL and heat-flux closures follow its
shallow-column method. Fine-column `deriveLift` retains its existing method.
`daylight: false` skips convection while retaining LCL and model-PBL integrals.
All inputs belong to one normalized frame. The
[`native parameters`](src/parameters.ts) bind these conventions to descriptors.

`deriveSoaringViews` computes the 1.0/1.143 m/s ceilings, cloud potentials, scalar
wind, vector shear and buoyancy/shear ratio from optional native physical
inputs. Missing dependencies stay null; calm wind has no direction. Cloud
regime booleans retain unknown values. Heights share the input model terrain.
Overdevelopment also requires relative humidity at the thermal top.

`nativeColumnCloudDiagnostics`, `nativeColumnWindAtHeight` and
`nativeColumnHumidityAtHeight` evaluate an explicit MSL layer boundary from a
published profile. Supply its stored thermal top or model-PBL fallback to retain
the emitted column's basis. `deriveCloudRegime` evaluates cloud flags directly
for whole-grid callers.

## Entry points

- [`@av/soaring`](src/index.ts): fine/native column calculations and point views.
- [`@av/soaring/velocity`](src/velocity.ts): Lenschow updraft profile,
  `usableLiftDepthM`, and `SINK_RATE_PRESETS_MPS`.
- [`@av/soaring/parameters`](src/parameters.ts): default solver parameters.

See [science](../../docs/science.md#lift-depth-and-usable-top).

```sh
pnpm test packages/soaring
```
