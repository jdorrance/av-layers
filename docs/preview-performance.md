# Preview layer performance

Prepared layer and time switches reached a 37.9 ms p95 in this controlled desktop run.

```sh
pnpm bench:preview --baseline b82963df329733055da72cacd768da25f1d96641 \
  --channel chrome --repeats 30 --out output/preview-layer-bench/results.json
```

## Measured result

| Interaction | Samples | Baseline p50 / p95 (ms) | Prepared p50 / p95 (ms) | Target HTTP requests, baseline / prepared |
| --- | ---: | ---: | ---: | ---: |
| Cached AGL/MSL toggle | 30 | 50.3 / 51.1 | 33.1 / 35.7 | 0 / 0 |
| Automatic adjacent step | 30 | 50.0 / 50.7 | 33.8 / 37.9 | 0 / 0 |
| Direction reversal at timeline end | 5 | 50.2 / 50.7 | 34.2 / 34.7 | 0 / 0 |
| Explicitly prepared time selection | 30 | 50.2 / 51.0 | 33.5 / 35.0 | 0 / 0 |
| Rapid superseding selection | 5 | 65.5 / 66.4 | 68.4 / 68.5 | 0 / 0 |
| Layer switch after a pan | 5 | 65.7 / 174.1 | 18.8 / 163.5 | 12 / 12 |

The first AGL/MSL toggle after idle took 398.5 ms before and 33.0 ms after; target requests fell from 32 to 0. A cold distant layer/time selection took 377.7 and 398.7 ms respectively. Each of those cases has one sample.

Automatic stepping uses the overlay’s directional prediction. Explicit preparation calls `prepare` before selection. Both wait for the map and background transport to settle between actions. Rapid supersession always selects a final target different from the currently displayed frame. Cold tiles after a pan remain a visible cost.

Peak active HTTP handlers were 4 / 4. The changed overlay retained two sources; the baseline retained one. Total tile responses across the complete session were 562 / 517 and 8.81 / 8.11 MiB.

## Scope and reproduction

Source digests cover the overlay, raster transport and prefetch planner:

```text
baseline 3902779b29a379150efff575d300b9aad38db34af4304a27abdd7b87ebcdd6df
prepared d68c4d5a6171f706ffb9763d2b752e2aac889e298a81c9cc04fbfa586afffbcc
```

Captured 13 November 2026 at 07:37 EST. Chrome 157.0.8103.79 used Apple M4 Max Metal through ANGLE. The viewport was 1920 × 1080 at device scale 1 and map zoom 7.15, with 32 visible forecast tiles. Both variants used Node 22.23.4, MapLibre 6.16.0 and `maxTileCacheSize:16`.

The [harness](../scripts/preview-layer-bench.ts) runs the real raster overlay against local patterned 256 × 256 lossless WebP tiles with 40 ms injected response delay. Timing ends on a render after the displayed-selection commit, when the center and four viewport quadrants match the target layer and time. Sources remain fixed during each run; their SHA-256 fingerprints are stored in the result JSON.

This isolates raster scheduling, decoding, upload and rendering. The basemap, full preview control handlers, startup discovery, production R2 path, network bandwidth limits and mobile devices require separate profiles. The first-load and five-sample cases are diagnostics; the 30-sample cases estimate warm desktop tails.

CDP used JavaScript heap at session end was 29.4 MiB before and 12.5 MiB after. These unforced-GC snapshots include runtime allocation variation; GPU texture allocations are excluded. The source and out-of-view tile limits bound retention independently of these snapshots.

The command writes complete samples and final-view PNGs under `output/preview-layer-bench/`. The JSON records browser/renderer identity, source fingerprints, request counts and heap snapshots.
