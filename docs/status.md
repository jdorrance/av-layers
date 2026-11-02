# Project status

The project is in alpha. GFS is the only live model, with usable lift above sea
level, usable lift above model ground, and precipitation rate.

Open the [production map](https://windy-av-preview.pages.dev/),
[Windy plugin](https://www.windy.com/dev/windy-av-preview.pages.dev/windy-plugin/plugin.min.js),
or [API documentation](https://windy-av-api-production.jdorrance.workers.dev/docs).

## Hourly build admission

The 24-frame hourly GFS builds at `f36f395` completed validation but exceeded the
previous 20-minute publication gate:
[staging](https://github.com/jdorrance/av-layers/actions/runs/41508157166) took
2,413,241 ms (40m13s), and
[production](https://github.com/jdorrance/av-layers/actions/runs/41508126229) took
2,427,607 ms (40m28s). Neither attempted publication. The hourly product has
291,096 tile entries, three times the previous eight-frame product.

These measurements support a 50-minute elapsed-time allowance in the
[build budgets](../apps/batch/src/capacity.ts), with the existing memory, tile,
and sample-pack limits. This admission change does not demonstrate a speedup;
parallel execution needs its own runtime measurements.

## November 2 release

The pending changes were reviewed, corrected, and merged with current main in
[PR 16](https://github.com/jdorrance/av-layers/pull/16). The final code checks passed
**625 tests in 57 files**, plus lint, types, documentation checks, and app builds.
The review fixed response-body ownership, content-based palette cache tags,
upload cancellation, schedule monitoring, and Windy lifecycle races. Duplicate
wake handlers were removed. Workflows remain small wrappers around pnpm commands.

The fresh 12Z forecast is
`20261102T172417Z-8b355ab5-81ea-421c-b6ac-3dc03a02559e`, built from `051a8cf`.
Its [staging run](https://github.com/jdorrance/av-layers/actions/runs/41490757874)
validated every payload, coverage mask, sample flag, and all 97,032 tile entries.
The hosted build took **16.36 minutes** and peaked at **994 MiB RSS**, inside the
20-minute and 2-GiB limits. Production uses the
[exact tested files](https://github.com/jdorrance/av-layers/actions/runs/41494570293)
and [tested API and clients](https://github.com/jdorrance/av-layers/actions/runs/41494576023).
Previous builds remain available for rollback.

Fresh local API checks, with production logging enabled, passed both cache modes
and near-limit payload tests. Each normal run completed 3,000 requests without
errors or drops. The largest sampled allocation was **88.43 MiB**, below the
96-MiB test limit. Overload returned bounded, uncached 503 responses and recovered.
These are local workerd samples, not continuous deployed-isolate measurements.

The actual Windy host and desktop/mobile map have rendered tiles and complete
point tables. Checks cover time selection, keyboard scrolling, overzoom,
close/reopen, historical warnings, and visible tile/point failure and recovery.
Delayed callbacks and suspended timers also have regression coverage. Retry,
rollback, invalid-target rejection, monitoring, and protected cleanup passed.
One cancelled upload reached commit; it is not evidence of a pre-commit abort.

Earlier five-pair build measurements reduced median time from 28.65 to 5.53
minutes with identical packed values and decoded pixels. Those measurements
compare `3659702` with `1d78d1c`; they are not a new benchmark of this follow-up.
Earlier remote API load checks passed, but predate the final response/parser
changes. Additional benchmark and remote load testing was stopped at the user's
request. No result is claimed for that unrun replay.

Detailed results and screenshots are kept locally under
`output/evidence/foundation/` and `output/evidence/simplify-foundations/`.
Experiment helpers are not tracked source. Nine unused GitHub secrets/variables
were removed; required environment settings remain.

## Remaining validation and deferred work

Two consecutive normal scheduled production publications have **not yet been
observed**, so that foundation qualification gate remains open. Manual runs and
same-cycle skips do not count. The normal forecast and health schedules remain
enabled; no extra follow-up automation was created for this wrap-up.

Physical-device testing is deferred. Desktop mobile-layout checks do not replace
it. New models, enhanced WRF, profiles, and other products remain deferred.

See [development](development.md), [operations](operations.md), and
[the roadmap](roadmap.md) for the next time work resumes.
