# Project status

The project is in alpha. GFS is the only supported live model. It provides usable
lift above sea level, usable lift above model ground, and precipitation rate
through the API, standalone map, and Windy plugin.

Open the [production map](https://windy-av-preview.pages.dev/),
[Windy plugin](https://www.windy.com/dev/windy-av-preview.pages.dev/windy-plugin/plugin.min.js),
or [API documentation](https://windy-av-api-production.jdorrance.workers.dev/docs).

## November 2 release checks

The production cutover used build
`20261102T153050Z-7d2b5638-878c-4b39-9149-4854288c66b7`, produced by `73025ec`.
[Staging](https://github.com/jdorrance/av-layers/actions/runs/41472250670),
[exact-file promotion](https://github.com/jdorrance/av-layers/actions/runs/41477738281),
and [production deployment](https://github.com/jdorrance/av-layers/actions/runs/41478550965)
succeeded. The three previous production builds remained available for rollback.

The final local `pnpm verify` run passed 602 tests plus lint, type checks,
documentation checks, and both app builds. Nine unused GitHub secrets/variables
were removed; live environment credentials and required settings were preserved.

- Five warm build pairs on an M4 Max with Node 22.23.4 reduced median time from
  **28.65 to 5.53 minutes**. Packed values/flags and all **97,032 decoded tiles**
  matched exactly. The separate empty-cache build took **7.63 minutes**.
  All candidate builds met the 20-minute/2-GiB limits. Memory did not improve:
  median process RSS rose about 5%; maximum sampled process-tree RSS was 1.33 GB.
- Remote API load used 3,000 requests per cache mode, 10 requests/s for five
  minutes, with a 90% tile / 4% sample / 6% metadata mix. No errors or dropped
  requests occurred. Tile/sample p95 was **109/73 ms** for verified response-cache
  hits and **295/210 ms** with that cache disabled. One warm-workload tile was a
  miss (237 ms), reported separately. Measurements came from one Cloudflare location.
- Local memory sampling with production logging enabled peaked at **87.63 MiB**
  across GFS and near-limit payload tests, below the 96-MiB test limit. Saturation
  returned bounded, uncached 503 responses and recovered. These are local workerd
  samples, not a measurement of continuous deployed-isolate peak memory.
- The actual Windy host and desktop/mobile preview rendered tiles and complete
  point tables. Production values matched staging. Time selection, keyboard
  controls, overzoom, historical-data warnings, close/reopen, and visible tile/point
  failure and recovery were checked. Suspended timers and late responses also
  have deterministic regression tests.
- Remote retry, rollback, invalid-target rejection, monitor failure/recovery,
  and cleanup passed. [Recovered staging health](https://github.com/jdorrance/av-layers/actions/runs/41471562379)
  had no findings. Cancellation during one upload reached commit; retry confirmed
  the same objects and pointer. It is not counted as an upload stopped before commit.

Timing measurements belong to `3659702`, compared with `1d78d1c`. The final
producer inputs and resolved dependencies matched that measured version. Declaring
an existing YAML test dependency changed the conservative lockfile-based recipe
identity, so the cutover used a fresh build; its 25 forecast payloads also matched
the previously qualified build.

Detailed local results and screenshots are in `output/evidence/foundation/`,
`output/evidence/simplify-foundations/`, and
`output/evidence/simplify-staging-drills-20261102/`. Experiment helpers stay outside
the tracked source. [CI](https://github.com/jdorrance/av-layers/actions/workflows/ci.yml)
runs the normal pnpm checks.

## Remaining completion check

The foundation milestone remains open until **two consecutive scheduled
production publications** succeed. Manual promotions and same-cycle skips do not
count. The next scheduled times are November 2 at 17:17 UTC and November 3 at
05:17 UTC; GitHub may start them later. The schedule has not been accelerated for
testing.

Physical-device testing is explicitly deferred. Mobile layout checks do not
replace it. Generated fixtures prove additional grid shapes, not live models.
New models, WRF processing, profiles, and other forecast products remain deferred.

See [development](development.md) for local use, [operations](operations.md) for
running the service, and [the roadmap](roadmap.md) for future work.
