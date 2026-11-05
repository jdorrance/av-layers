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

`deriveSelectedFrameDiagnostics(frame, sourceIndices)` computes diagnostics and
flags for selected global source indices. Its full-grid buffers feed terrain
clearance at sparse targets; `bufferBytes` counts their typed storage. Callers
apply daylight gating when deriving target clearance.

## Entry points

- [`@av/forecast/frame`](src/frame.ts): `deriveFrame` whole-grid calculation.
- [`@av/forecast/refinement`](src/refinement.ts): reusable native-to-target
  weights, terrain-column MSL/AGL and terrain-clearance fallback.
- [`@av/forecast/science`](src/science.ts): `deriveColumn` single-column MSL/AGL
  and status mapping around [`@av/soaring`](../soaring/README.md).
- [`@av/forecast/sampler`](src/sampler.ts): bilinear/nearest-neighbor point
  sampling and Web Mercator tile sampling plans.
- [`@av/forecast/intervals`](src/intervals.ts): `recoverTrailingWindow` for
  cumulative and run-averaged model fields.
- [`@av/forecast/sample-pack`](src/sample-pack.ts): block layouts and one-range
  point-query plans for legacy packs and bounded version-5 shards.
- [`@av/forecast/support`](src/support.ts): grid neighbor lookup.
- [`resolveProductFrameHours`](src/daylight.ts): pre-acquisition daylight frame
  filter, exported from `@av/forecast`.

## Terrain clearance

`prepareTerrainClearance` compiles native-to-target weights. Its `derive` method
reads caller-owned diagnostics, native support flags, DEM arrays and a UTC
interval, returning new MSL and AGL fields. `byteLength` reports retained mapping bytes. Missing
terrain or native support produces unavailable cells.

Terrain clearance supplies unsupported-valley fallback and evaluation controls.
It requires complete native diagnostics; mixed convective and non-convective
neighbors are unavailable. See [terrain clearance](../../docs/science.md#terrain-clearance)
for the calculation.

## Terrain columns

`prepareTerrainColumns` compiles compact donor slots and returns a per-frame
`derive` operation for DEM elevations. [terrain-column.ts](src/terrain-column.ts)
owns surface transfer, pressure and humidity closure, failure counters and probes.
The solver-owned [workspace](../soaring/src/column.ts) validates native donors
and merges their breakpoints into an environmental profile above each fine cell.

`byteLength` counts retained mapping buffers. `workspaceBufferBytes` and
`daylightBufferBytes` count typed-array storage; `workspaceObjectBudgetBytes`
estimates JavaScript overhead. Returned field buffers and preparation temporaries
have separate lifetimes. [Build admission](../../apps/batch/src/capacity.ts) retains
the prepared mapping for frame execution and accounts for these buffers.

`packedTerrainColumnBudget` returns those byte counters after the same admission
checks. `preparePackedTerrainColumns` derives whole-domain fields in sparse
active-cell offset order. `PackedGridField` shares immutable coverage with the sampler and
raster consumers. Native-grid donor support comes from
[`planWholeDomainGrid`](../contracts/src/whole-domain-grid.ts).
`prepareTerrainColumns` retains the regional mapping path for evaluation.

Surface excess is evaluated at each donor's native terrain and interpolated with
the original horizontal weights. Environmental weights are renormalized among
height-supported donors. Support-entry knots retain their one-sided temperature
limits in the reconstructed profile. Donor relative humidity uses the supported
weights before conversion to fine-cell specific humidity;
[science](../../docs/science.md#terrain-columns) owns the equations.
[Method descriptors](../contracts/src/methods.ts) select the pressure coordinate
and publish the shared parameters.

`clearanceFallback: 'unsupported'` accepts same-frame `nativeClearance`
diagnostics and flags. The shared cell calculation runs when a column exceeds
the supported below-ground bridge. The regional evaluation path also accepts
precomputed clearance fields. Both inputs bind the frame, grid and valid time.
Fallback probes identify their provenance; [science](../../docs/science.md#terrain-clearance)
owns the calculation.

See [data](../../docs/data.md) for units and status flags.

```sh
pnpm test packages/forecast
```
