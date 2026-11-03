# `@av/thermodynamics`

Dry-air thermodynamic conversions, saturation vapor pressure and mixing ratio,
lifted condensation level (LCL), and surface virtual heat flux.

## Usage

```ts
import { dewpointFromTempAndRhC, lclHeightMetersAgl } from '@av/thermodynamics';

const temperatureC = 25;
const dewpointC = dewpointFromTempAndRhC(temperatureC, 50);
const condensationHeightAglM = lclHeightMetersAgl(temperatureC, dewpointC);
```

Function names carry their units (`C`, `K`, `Hpa`, `MetersAgl`, `KgPerKg`,
`GPerKg`). Out-of-range inputs (such as nonpositive pressure or relative
humidity) return `NaN`. [`@av/thermodynamics/constants`](src/constants.ts)
exports the physical constants consumed by the solver and method descriptors.

See [science](../../docs/science.md).

```sh
pnpm test packages/thermodynamics
```
