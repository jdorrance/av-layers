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
- [`@av/forecast/refinement`](src/refinement.ts): prepare reusable native-to-target
  geometry and calculate terrain-referenced AGL from existing MSL ceilings.
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

## Terrain-referenced clearance

`prepareTerrainClearance(sourceMask, targetMask)` captures the coverage and grid
geometry once. Its `derive` method reads a native MSL `GridField`, target-grid
DEM elevations and byte validity (`1` means valid), and the UTC `intervalStart`
and `validTime`. It returns a new target-grid AGL field; it does not change or
duplicate the source MSL forecast. `byteLength` reports the retained mapping
arrays. Input arrays remain caller-owned and are not retained between calls.

Every positive-weight native contributor must be in source output or halo
coverage and have the same known lift status. Valid ceilings are interpolated
before subtracting DEM elevation; clearance below terrain becomes zero. All
no-lift contributors stay zero. Mixed lift/no-lift states, incomplete support
and missing DEM cells remain unavailable. No nearest-cell substitution fills
gaps. Target output and halo cells are calculated; other cells stay outside.

Daylight uses the same start/midpoint/end checks as frame calculation. Darkness
produces zero lift when target terrain and native support geometry are known,
without requiring weather values; missing terrain remains unavailable. Pass
`false` as the fourth argument to `derive` to disable daylight filtering.

This depth is clearance below the existing model ceiling, including where DEM
ground lies below model ground. It does not establish thermals starting at that
local surface or change the atmospheric prediction. Dataset identity and
vertical-reference compatibility belong to the caller's terrain provenance.

See [data](../../docs/data.md) for units and status meanings, and
[science](../../docs/science.md) for the calculations and interpolation rules.

Run tests from the repository root:

```sh
pnpm test packages/forecast
```
