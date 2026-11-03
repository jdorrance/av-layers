# `@av/thermodynamics`

Temperature conversions, humidity calculations, dry parcel cooling, and surface
heat-flux calculations.

## Usage

```ts
import { dewpointFromTempAndRhC, lclHeightMetersAgl } from '@av/thermodynamics';

const temperatureC = 25;
const dewpointC = dewpointFromTempAndRhC(temperatureC, 50);
const condensationHeightAglM = lclHeightMetersAgl(temperatureC, dewpointC);

console.log({ dewpointC, condensationHeightAglM });
```

Relative humidity is a percentage. The example returns dewpoint in °C and an
estimated lifted condensation level in meters above ground.

The [functions](src/index.ts) use units in their names: temperatures are °C or K,
pressure is hPa, and altitude is meters. `virtualPotentialTemperatureK` takes a
mixing ratio in kg/kg; `saturationMixingRatioGPerKg` returns g/kg. Rejected inputs
return `NaN`, including nonpositive pressure for potential temperature and
nonpositive relative humidity for dewpoint.

[`@av/thermodynamics/constants`](src/constants.ts) exports the physical constants,
including the default dry lapse rate. See the [science guide](../../docs/science.md)
for their use in the forecast calculations.

Run tests from the repository root:

```sh
pnpm test packages/thermodynamics
```
