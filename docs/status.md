# Project status

The project is in alpha. GFS is live in production with `usable-lift-msl`,
`usable-lift-agl`, and `precip-rate`. ICON-EU (`usable-lift-msl`,
`usable-lift-agl`) is implemented in the batch builder and workflows.

Live links: [production map](https://windy-av-preview.pages.dev/),
[Windy plugin](https://www.windy.com/dev/windy-av-preview.pages.dev/windy-plugin/plugin.min.js),
and [API documentation](https://windy-av-api-production.jdorrance.workers.dev/docs).

## Terrain inputs

Global Copernicus GLO-90 ingestion, bounded window reads, and grid preparations
are implemented ([terrain guide](../apps/batch/src/terrain/README.md)). Armenia
and polar COG tiles passed lossless repacking and `rasterio` sampling checks
against the 26,475-tile source inventory. Run the **Global terrain** workflow
from `main` to populate the R2 catalog.

## ICON-EU qualification

The ICON-EU adapter implements regional daylight frame selection, per-column
model-level pressures, DWD flux de-averaging, and pure-TypeScript `bzip2` and
CCSDS DRT 5.42 decoding. Synthetic serial/parallel builds and retained DWD probe
checks pass in the test suite. Next step: run and record a full 24-hour ICON-EU
build on the hosted runner and verify staging and production publication
([development](development.md#build-a-real-forecast)).

## Hourly build admission

The 24-frame hourly GFS builds at `f36f395` (291,096 tiles across 24 frames × 3
layers) completed validation in **40m13s** on
[staging](https://github.com/jdorrance/av-layers/actions/runs/41508157166) and
**40m28s** on
[production](https://github.com/jdorrance/av-layers/actions/runs/41508126229).
[Build budgets](../apps/batch/src/capacity.ts) allow 50 minutes of elapsed time
alongside the 4-shard parallel workflow in [parallel.ts](../apps/batch/src/parallel.ts).

## November 2 release

Merged in [PR 16](https://github.com/jdorrance/av-layers/pull/16) with 625
passing tests across 57 files:

- Published 12Z GFS build `20261102T172417Z-8b355ab5-81ea-421c-b6ac-3dc03a02559e`
  from `051a8cf` ([staging run](https://github.com/jdorrance/av-layers/actions/runs/41490757874):
  16.36 min, 994 MiB peak RSS, 97,032 tiles; promoted to
  [production](https://github.com/jdorrance/av-layers/actions/runs/41494570293)
  with [API and client deploy](https://github.com/jdorrance/av-layers/actions/runs/41494576023)).
- Completed 3,000-request local `workerd` load runs in both cache modes with zero
  errors and **88.43 MiB** peak sampled heap (below the 96 MiB gate).
- Verified Windy host plugin and standalone MapLibre preview across time
  selection, keyboard navigation, overzoom, BFCache lifecycle, and rollback.

## Remaining validation

- Observe two consecutive scheduled production runs (`05:17` and `17:17 UTC`).
- Record full hosted ICON-EU build timings and publication.
- Test on physical mobile devices.

See [development](development.md), [operations](operations.md), and
[the roadmap](roadmap.md).
