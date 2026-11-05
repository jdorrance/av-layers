# Whole-domain refinement progress

Implementation and independent code review are complete on `feature/higher-res-11-4-2026-v2`, based on `0702cae91d6f0784931f419fe032ca7cb42f30d3`. Full real-data and deployed acceptance remain blocked.

## Verification

- `pnpm verify`: 117 test files passed; 1,571 tests passed and one optional DWD probe skipped. Lint, root/API typecheck, generated references, Markdown links, preview/plugin builds, Wrangler staging dry-run and `git diff --check` passed.
- `pnpm exec node -p 'process.version'`: v22.23.4. The pnpm host emits a separate Node 20 engine warning.
- Independent review of the cumulative change set: **pass**, with no actionable findings remaining. All substantive review fixes were rechecked.
- The handoff was staged at task start. The unrelated `docs/build-performance-parallelism-handoff.md` is preserved outside this change.
- Measurement host: macOS arm64, 16 CPUs, 128 GiB RAM.

## Coverage and serving

- Native Africa exclusions: GFS 149,955 output cells and 14,833 halo-only cells; ICON-EU 399,913 output cells and 9,771 halo-only cells.
- Full ICON-EU k=5 mask: 9,981,126 active cells, 40,668 blocks, 2,928,156 sparse bytes; generation took 19.40 s with 123,469,824 bytes peak RSS.
- Full GFS k=10 mask: 14,583,173 active cells, 61,472 blocks, 4,426,044 sparse bytes; generation took 55.68 s with 157,728,768 bytes peak RSS.
- `FINE_MASK_REAL_SOURCE=1 uv run --python 3.14.7 --with shapely==2.1.2 --with pyproj==3.7.2 --with pyshp==2.3.1 python scripts/masks/test_fine_masks.py`: five tests passed, including TypeScript schema, halo and encoding checks. Each bundled `fine/source.json` records generator and pinned-source provenance.
- Full-mask serving fixtures retain configured fine masks and native coverage within the 24 MiB coverage cache (expanded from the earlier 8 MiB fixture cap). Concurrent cold reservations peaked at 22,911,506 bytes within 32 MiB. Local cold/warm lookups were about 2.5 s/2 ms for GFS and 1.7 s/1 ms for ICON. These are local validator-backed tests, not deployed Worker load or heap measurements.

## Numerical and raster measurements

- Packed/dense parity, native nodes, donor edges, lazy clearance, cancellation and deadlines pass the numerical suites. Fixture knot rebuilds fell from 189 to 20 at k=5 and 451 to 20 at k=10. A small warmed derivation benchmark showed no meaningful timing improvement.
- Cooperative derivation shares the synchronous numerical loop and output buffers. A 19,881-cell fixture measured 13.81/14.41 ms median synchronous/asynchronous time and 1.18 ms maximum observed chunk. These are fixture measurements, not global latency bounds.
- Raster admission preserves the legacy 64 MiB default and the 2 GiB process limit. Whole-domain admission permits three workers with runtime worker reduction or inline fallback when RSS headroom is insufficient. Estimated complete working sets are approximately 1.49 GB for GFS and 1.76 GB for ICON-EU.
- Raster-only benchmarks used validated full coverage, two synthetic packed fields, 48 tiles and 96 outputs. Output hashes matched across inline, two-worker and three-worker runs. GFS raster times were 11.425/6.933/5.372 s, with peak RSS 326.5/549.5/576.1 MB. Final production-pool ICON runs measured 8.206 s and 446,234,624 bytes RSS for two workers, and 5.589 s and 483,655,680 bytes for three; the inline baseline was 13.733 s.

Reproduce raster measurements with `/usr/bin/time -l pnpm exec node --import tsx apps/batch/src/raster-pool.bench.ts MODEL WORKERS`, using `gfs` or `icon-eu` and `0`, `2` or `3`. These measurements exclude forecast acquisition, derivation and complete archive production.

## Audit corrections

Regression tests cover Float32 byte offsets, channel chunks aligned to 5-byte records, evicted file handles, owned-file cleanup, duplicate block/wrap records, complete phase metrics, positive native donors, lazy clearance, frozen receipts, bounded reads and request lifetimes. Terrain inputs are verified before first use, old pre-proof prepared artifacts have a distinct identity, and transport/body retries share a bounded admission loop. Source counters distinguish returned bytes from conservative body-attempt bounds.

The reported 512×512 shard failure is fixed; writer/layout/legacy pack tests passed 36 tests. The bounded-read spy is corrected. Parent verification of writer and storage regressions passed 50 tests. Raster parallelism is enabled through measured admission rather than an unconditional limit increase.

## Real build attempts

The official GLO-90 inventory was fetched and pinned: SHA-256 `e5a5efe088e70506bc1007d22006bdcb09b0ec03177b62f9652363c13f49ed97`, 26,475 tiles and 1,111,950 bytes. After `pnpm terrain inventory --out output/evidence/whole-domain-terrain --store-dir .cache/terrain` staged the verified snapshot, both complete-domain commands reached DEM preparation:

```sh
pnpm forecast --model gfs --out output/evidence/whole-domain-gfs --cache-dir .cache/gfs --terrain-catalog-ref output/terrain-release-41645552750/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
pnpm forecast --model icon-eu --out output/evidence/whole-domain-icon-eu --cache-dir .cache/icon-eu --terrain-catalog-ref output/terrain-release-41645552750/terrain-catalog-ref.json --terrain-store-dir .cache/terrain
```

- GFS stopped at missing or changed `Copernicus_DSM_COG_30_N64_00_E009_00_DEM`: 11.04 s, 384,483,328 bytes peak RSS.
- ICON-EU stopped at missing or changed `Copernicus_DSM_COG_30_N69_00_E015_00_DEM`: 8.01 s, 385,089,536 bytes peak RSS.
- Catalog SHA-256: `ea3deca482167f825fd6e05d24c120d56c7c0511d2dd52b13f220e77f011137a`. Neither attempt acquired a weather cycle or produced a validated forecast.

Supply the complete immutable catalog assets to `.cache/terrain` and repeat these commands, or use the matching R2 store by omitting `--terrain-store-dir` with R2 credentials configured. The local store contains only 16 COG assets. No Cloudflare/R2 credentials were available at inventory time.

## Outstanding acceptance

Complete both real-data builds, measure full-build elapsed time and RSS, run deployed serving/load/cancellation checks, and verify live publication and rollback with the required credentials. Code and fixture checks pass; these external gates remain unverified, so this branch is not yet described as ready to ship.
