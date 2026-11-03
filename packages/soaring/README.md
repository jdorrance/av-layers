# `@av/soaring`

Calculate thermal lift depth and convective velocity from a temperature profile
and surface heat fluxes.

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
  console.log(lift.usableDepthM); // metres above the column's terrain
}
```

Use °C for temperatures, hPa for surface pressure, and upward-positive W/m² for
heat fluxes. Profile heights are metres above sea level, ordered from lowest to
highest. Humidity accepts either `specificHumidityKgKg` or `dewPointC`.

The second argument selects how many profile levels to read. Pass `levels.length`
for a complete profile, or a smaller count when reusing an array. An invalid
count throws `RangeError`.

## Results

- `valid`: `usableDepthM` is the estimated usable depth above terrain for the
  chosen sink rate.
- `no-lift`: `usableDepthM` is zero.
- `unavailable`: required weather data is missing or invalid; numeric results are
  `null`.

`depthM` is the convective layer depth, `thermalVelocityMps` is its velocity scale,
and `branch` describes how the depth was calculated. Supply `pblHeightM` when the
first profile level is neutral or stable; the solver uses it to limit that case.

## Other exports

- [`@av/soaring/velocity`](src/velocity.ts): Lenschow updraft curves,
  `usableLiftDepthM`, and sink-rate presets. Use this when depth and velocity are
  already known.
- [`@av/soaring/parameters`](src/parameters.ts): default calculation settings.
- [`ColumnDerivationOptions`](src/column.ts): per-call options, including sink
  rate, lapse rate, and maximum profile gap.

See [science](../../docs/science.md#lift-depth-and-usable-top) for the equations
and profile assumptions. For gridded MSL/AGL output, use
[`@av/forecast`](../forecast/README.md).

Run tests from the repository root:

```sh
pnpm test packages/soaring
```
