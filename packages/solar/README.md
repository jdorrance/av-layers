# `@av/solar`

NOAA-style solar position, sunrise/sunset times, top-of-atmosphere flux factor,
and grid daylight testers.

## Usage

```ts
import { solarPosition } from '@av/solar';

const position = solarPosition(40.7128, -74.006, Date.parse('2026-06-21T16:00:00Z'));
console.log(position.elevationDeg, position.azimuthDeg, position.isDaylight);
```

Latitudes and longitudes (positive east) are in degrees; timestamps are UTC
milliseconds.

## Entry points

- [`@av/solar`](src/index.ts): `solarPosition`, `sunriseSunset` (returns UTC
  sunrise/sunset timestamps, day length, and polar day/night `kind`), and
  `solarFluxFactor`.
- [`@av/solar/grid`](src/grid.ts): `createGridDaylightTester` for regular
  lat/lon and projected grids.
- [`@av/solar/parameters`](src/parameters.ts): `DEFAULT_HORIZON_DEG` (`-0.833°`).

See [science](../../docs/science.md).

```sh
pnpm test packages/solar
```
