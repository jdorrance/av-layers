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

## Entry points

- [`@av/forecast/frame`](src/frame.ts): `deriveFrame` whole-grid calculation.
- [`@av/forecast/science`](src/science.ts): `deriveColumn` single-column MSL/AGL
  and status mapping around [`@av/soaring`](../soaring/README.md).
- [`@av/forecast/sampler`](src/sampler.ts): bilinear/nearest-neighbor point
  sampling and Web Mercator tile sampling plans.
- [`@av/forecast/intervals`](src/intervals.ts): `recoverTrailingWindow` for
  cumulative and run-averaged model fields.
- [`@av/forecast/sample-pack`](src/sample-pack.ts): $16 \times 16$ block layout
  and byte-range planning for `samples.bin`.
- [`@av/forecast/support`](src/support.ts): grid neighbor lookup.
- [`@av/forecast/daylight`](src/daylight.ts): `resolveProductFrameHours`
  pre-acquisition daylight frame filter.

See [data](../../docs/data.md) and [science](../../docs/science.md).

```sh
pnpm test packages/forecast
```
