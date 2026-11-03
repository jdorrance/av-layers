# `@av/forecast`

Turn weather-model arrays into lift and precipitation grids, sample those grids
at map coordinates, and encode point-forecast data.

## Calculate a frame

A source adapter supplies a `NormalizedFrame`; a `CoverageMask` selects the grid
cells to calculate. Choose the layers to produce with `layers`:

```ts
import type { CoverageMask } from '@av/contracts';
import type { NormalizedFrame } from '@av/forecast/inputs';
import { deriveFrame } from '@av/forecast/frame';

export function calculateLift(frame: NormalizedFrame, mask: CoverageMask) {
  return deriveFrame(frame, mask, {
    layers: ['usable-lift-msl', 'usable-lift-agl']
  });
}
```

Each returned field contains a `Float32Array` of values and a `Uint8Array` of
status flags, indexed across the full grid. Only requested layers are allocated.
Both lift layers share the same column calculation. Daylight filtering is on by
default.

Adapters return temperatures in K, surface pressure in Pa, heights in metres,
and upward heat fluxes in W/m². Profiles use either a shared hPa pressure axis
or per-column Pa arrays. `validateNormalizedFrame` checks array sizes, pressure
representation and missing-value masks before calculation; the batch builder
calls it for every acquired frame. See [input types](src/inputs.ts) for the fields.

## Entry points

- [`@av/forecast/frame`](src/frame.ts): derive requested layers from a model frame.
- [`@av/forecast/science`](src/science.ts): `deriveColumn` returns MSL/AGL values
  and status flags for one column. For physical lift depth alone, use
  [`@av/soaring`](../soaring/README.md).
- [`@av/forecast/sampler`](src/sampler.ts): sample fields by latitude/longitude,
  or prepare repeated sampling over a map tile.
- [`@av/forecast/intervals`](src/intervals.ts): recover trailing means and rates
  from cumulative source fields.
- [`@av/forecast/sample-pack`](src/sample-pack.ts): lay out numeric blocks and
  locate the byte ranges needed for a point query.
- [`@av/forecast/support`](src/support.ts): find neighboring cells for
  interpolation and grid operations.

The root export also includes `resolveProductFrameHours`, which selects forecast
hours from a product's daylight settings.

See [data](../../docs/data.md) for units and status meanings, and
[science](../../docs/science.md) for the calculations and interpolation rules.

Run tests from the repository root:

```sh
pnpm test packages/forecast
```
