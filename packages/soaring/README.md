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
elements of `levels`).

## Return value

`deriveLift` returns `{ status, depthM, thermalVelocityMps, usableDepthM, branch }`:

- `valid`: `usableDepthM > 0` for the configured `sinkRateMps`.
- `no-lift`: `usableDepthM === 0`.
- `unavailable`: missing or invalid inputs; numeric fields are `null`.

`branch` distinguishes resolved parcel crossings, unresolved profile caps,
surface-stable columns, and non-convective columns.

## Entry points

- [`@av/soaring`](src/index.ts): `deriveLift` and column types.
- [`@av/soaring/velocity`](src/velocity.ts): Lenschow updraft profile,
  `usableLiftDepthM`, and `SINK_RATE_PRESETS_MPS`.
- [`@av/soaring/parameters`](src/parameters.ts): default solver parameters.

See [science](../../docs/science.md#lift-depth-and-usable-top).

```sh
pnpm test packages/soaring
```
