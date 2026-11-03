# `@av/solar`

Solar position, sunrise/sunset times, relative solar flux, and daylight checks
for points and grids using NOAA-style calculations.

## Usage

```ts
import { solarPosition } from '@av/solar';

const timestampMs = Date.parse('2026-06-21T16:00:00Z');
const position = solarPosition(40.7128, -74.006, timestampMs);

console.log(position.elevationDeg, position.azimuthDeg, position.isDaylight);
```

Coordinates and angles are degrees; timestamps are UTC milliseconds. Longitude
is positive east. `solarPosition` returns elevation, azimuth, and daylight status
along with ephemeris terms. Non-finite inputs produce `NaN` numeric fields and
`isDaylight: false`.

The [point functions](src/position.ts) also include `sunriseSunset`, which returns
UTC timestamps and day length in hours. Sunrise and sunset are `null` during
polar day or night; check `kind` for the regime. `solarFluxFactor` returns a
dimensionless top-of-atmosphere horizontal flux factor.

- [`@av/solar/grid`](src/grid.ts): `createGridDaylightTester` returns a function
  that checks a cell index for daylight at any supplied timestamp. It accepts
  regular latitude/longitude grids or projected grids with a coordinate converter.
- [`@av/solar/parameters`](src/parameters.ts): the default apparent sunrise/sunset
  horizon, used when a calculation's optional horizon argument is omitted.

See the [science guide](../../docs/science.md) for forecast daylight sampling.

Run tests from the repository root:

```sh
pnpm test packages/solar
```
