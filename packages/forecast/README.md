# `@av/forecast`

Derives gridded lift and precipitation fields from normalized model inputs,
samples grids at geographic coordinates, and packs block-indexed sample files.

## Usage

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

`deriveFrame` returns a `{ values: Float32Array, flags: Uint8Array }` grid per
requested layer, evaluating both lift layers in a single column pass and gating
daylight cells via [`@av/solar`](../solar/README.md).
`validateNormalizedFrame` checks array dimensions, vertical pressure axes
(`pressureLevelsHpa` or per-column `pressurePa`), and missingness masks before
derivation.

Pass caller-owned `diagnostics: { ceilingMslM, buoyancyM2S3, branch }` arrays
(one element per native grid cell) to inspect lift derivation. Each call resets
all slots. Arrays require separate buffers from inputs and coverage masks.
`ceilingMslM` records the convective-depth top; `FRAME_BRANCH` distinguishes a
parcel crossing, unresolved profile cap, surface-stable, non-convective and unavailable
support. `buoyancyM2S3` records `w*³ / depth`, including convective columns below
the usable-lift cutoff. Diagnostics preserve the published layer values.

## Entry points

- [`@av/forecast/frame`](src/frame.ts): `deriveFrame` whole-grid calculation.
- [`@av/forecast/refinement`](src/refinement.ts): reusable native-to-target
  weights and terrain-referenced MSL/AGL from native depth and buoyancy.
- [`@av/forecast/science`](src/science.ts): `deriveColumn` single-column MSL/AGL
  and status mapping around [`@av/soaring`](../soaring/README.md).
- [`@av/forecast/sampler`](src/sampler.ts): bilinear/nearest-neighbor point
  sampling and Web Mercator tile sampling plans.
- [`@av/forecast/intervals`](src/intervals.ts): `recoverTrailingWindow` for
  cumulative and run-averaged model fields.
- [`@av/forecast/sample-pack`](src/sample-pack.ts): $16 \times 16$ block layout
  and byte-range planning for `samples.bin`.
- [`@av/forecast/support`](src/support.ts): grid neighbor lookup.
- [`resolveProductFrameHours`](src/daylight.ts): pre-acquisition daylight frame
  filter, exported from `@av/forecast`.

## Terrain clearance

`prepareTerrainClearance` compiles native-to-target weights. Its `derive` method
reads caller-owned diagnostics, native support flags, DEM arrays and a UTC
interval, returning new MSL and AGL fields. `byteLength` reports retained mapping bytes. Missing
terrain or native support produces unavailable cells.

Base fields stay on the parent grid. Patches use local terrain and complete
convective-column support to publish both `usable-lift-msl` and
`usable-lift-agl`; mixed convective and non-convective neighbors are unavailable.
See [terrain clearance](../../docs/science.md#terrain-clearance)
for the calculation, daylight rules and vertical references.

See [data](../../docs/data.md) for units and status flags.

```sh
pnpm test packages/forecast
```
