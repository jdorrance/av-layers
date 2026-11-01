# Operations

The supported writer is GitHub Actions on `main`. Forecast and maintenance jobs
share `forecast-{environment}-gfs` with cancellation disabled. That concurrency
group provides exclusion; the in-process authority receipt is a guard against
accidental local invocation, not a distributed lock. Keep R2 write credentials
in the two protected GitHub environments. There are no API write routes.

## Publish a build

Run the existing workflow from current `main`:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs
```

Use `production` after staging qualification. Omit `cycle` to discover an
admissible source run. A historical cycle may be built locally for comparison,
but promotion requires a source age of at most 18 hours and at least six hours
of useful horizon. Builds also have a six-hour publication lifetime and
seven-day retention expiry. Forecast relevance and retention are different.

For an intentional replacement of the same source cycle, add
`-f allow-same-cycle=true`. Older cycles cannot replace a newer retained cycle,
even after rollback. Retained membership is bounded; capacity checks leave room
for replacement builds. Routine production publication runs at `05:17` and
`17:17 UTC`, then performs serialized cleanup before releasing the writer group.

Publication order is coverage bitsets and their content-addressed descriptor,
forecast artifacts, provenance, manifest, then conditional latest pointer. The
pointer uses the ETag captured before upload. A competing winner is preserved.
A failed/ambiguous pointer response is reconciled against stored authority before
reporting failure. An interrupted upload never admits a partial build.

Immutable retry means **create or prove equality**, never overwrite. New files
use Content-MD5, size/ETag checks and a 32-byte tail; this relies on R2 faithfully
validating and reporting its ETag. Existing objects are SHA-256 checked in bounded
ranges. Local files are read from an opened descriptor with size/change guards.
At most four uploads run, with a separate 512 MiB reservation covering bodies
and transport copies. One file is capped at 256 MiB. Metadata has smaller caps.

### Resume a failed upload

The failed workflow retains complete `builds/` and `coverage/` artifacts. Within
six hours, resume that exact build without regenerating tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=FAILED_RUN_ID
```

The workflow verifies the source run belongs to this repository's completed
`main` forecast workflow, then binds its revision to the clean manifest recipe.
Re-running a job replaces that run's retained artifacts; use a complete retained
artifact or start a fresh build.

Resume requires one complete build, current recipe/configuration identity,
resource budgets, full local validation and current-main verification. It
reconciles existing remote objects by content. If the recipe changed, artifacts
are missing, or lifetime/horizon admission fails, run a fresh build. A deliberate
same-cycle replacement still requires its explicit input. A completed same-build
retry succeeds without moving latest backwards or rewriting immutable files.

Build and resume share one cancellation and outcome journal. `failure.json`
reports `not-attempted`, `unconfirmed`, or `committed` publication. An
`unconfirmed` outcome means the authoritative read could not resolve an
ambiguous write; resume the exact artifact to reconcile it. A committed receipt
is written before maintenance. Cancellation after commit defers maintenance or
records its completed outcome; it never reclassifies publication as uncommitted.

### Qualify publication recovery in staging

Keep a complete build artifact with `-f retain-full-artifacts=true`, then run:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=qualify -f artifact-run-id=RUN_ID -f confirm=serialized-maintenance
```

This uses the real R2 adapter and publication algorithms under the same writer
lock. Every drill object lives under a unique `qualification/` namespace;
live catalog and build keys are untouched. The receipt records byte integrity,
interrupted/ambiguous writes, retry, independent-writer CAS conflict, intentional
same-cycle replacement, verified rollback and safe deletion. Cleanup age cases
advance a declared logical clock; they are not evidence of objects aged in wall
time. Namespace teardown is verified and any remaining scope is recorded on
failure. The downloaded source revision must match its verified forecast run.

## Deploy and schedule

Each environment has one private bucket, one Worker and one Pages project.
The mapping is checked against [Wrangler](../apps/api/wrangler.jsonc) before any
publication/deployment. Public `r2.dev` and bucket custom domains stay disabled.
The Worker reads via its bucket binding; clients have no provider credentials.

One-time setup remains **Bootstrap → Forecast sample → Deploy Worker and Pages**:

1. Create protected `staging` and `production` GitHub environments. Configure
   `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `R2_ACCOUNT_ID`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`; set `API_BASE_URL`, `R2_BUCKET`,
   `PAGES_PROJECT_NAME`. Scope R2 credentials to that environment's bucket.
2. Use the separate `CLOUDFLARE_BOOTSTRAP_TOKEN` for **Bootstrap Cloudflare
   resources** with `bootstrap-private-cloudflare`. Normal deployment needs
   Workers Scripts Edit and Pages Edit, not the bootstrap administration token.
3. Publish a fresh build, then deploy the matching Worker and clients:

```sh
gh workflow run deploy.yml --ref main -f environment=staging \
  -f confirm=deploy-read-only-worker
```

The deploy job runs CI, deploys the Worker with a commit/run/attempt marker,
requires that exact `/healthz` marker and real forecast smoke checks, then builds
and deploys Pages. Pages must report the same marker. The public
`/windy-plugin/plugin.js` and `plugin.min.js` bundles use the same HTTPS API base
and allow Windy-origin loading; they contain no credentials. Source maps are not
published by this workflow. The plugin remains an optional consumer of the same
read-only API.

Pushes to `main` normally deploy production. For an incompatible alpha cutover,
disable the deploy workflow temporarily, land the qualified revision, re-enable
it, then dispatch staging and production in order after their matching data is
published. Record the old/new Worker markers and retained rollback set. This is
an explicit release operation, not a permanent compatibility branch.

All workflows pin checkout to the triggering SHA. Forecast/resume checks current
`main` immediately before publication. A later branch update can race that check;
immutability and pointer CAS still preserve complete data. Routine forecast runs
never depend on an operator's laptop. GitHub schedules may be delayed or disabled;
monitor their observed run times rather than assuming the cron fired.

## Monitor and recover

[Forecast health](../.github/workflows/health.yml) runs hourly. It validates an
expanded manifest, a complete sample and a WebP tile, then checks source age,
remaining horizon and recent scheduled-writer status. The receipt is a GitHub
Actions artifact. Healthy checks send no messages. Configure GitHub's workflow
failure notifications for the repository's operators; failed run logs include
these actionable findings:

- `upstream-lag`: inspect NOAA input-proof and acquisition receipts; do not
  promote stale data to hide the outage.
- `missed-publication` / `missed-schedule`: inspect the latest scheduled run,
  credential/environment checks, source discovery and current-main rejection.
  Dispatch a fresh forecast from current `main` after resolving the cause.
- `shrinking-horizon`: distinguish upstream lag from a failed writer. Six hours
  is the warning/admission boundary; seven-day retention is not usable weather.
- `serving-integrity`: compare Worker/data schema, immutable descriptor/hash,
  artifact/provenance availability and the first failed smoke assertion.
- `publisher-or-cleanup-failure`: inspect `publication.json`, `maintenance.json`
  and `failure.json`. A cleanup failure after commit is reported explicitly;
  do not assume publication failed or blindly replace the build.

A liveness response alone is not a release proof. Request counters expose R2
reads/bytes, cache hits, coalescing and elapsed time without logging coordinates.
Cloudflare observability samples production requests and records staging checks.
[Serving budgets](serving-budgets.md) defines load, response-cache states and the
limits of local memory estimates. `AV_RESPONSE_CACHE=off` is a deployment-only
qualification setting; ordinary clients cannot bypass caches with a header.

Use **Forecast maintenance** for rollback or cleanup; it waits for the same
writer group. No Boolean claim that publishers are paused grants authority:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=rollback -f build-id=RETAINED_BUILD_ID -f confirm=serialized-maintenance
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=cleanup -f confirm=serialized-maintenance
```

Rollback verifies the retained, unexpired manifest, coverage descriptor and
bitsets, provenance and every forecast object's hash before pointer CAS. Cleanup
protects current/retained builds and removes only unreferenced builds whose IDs
and actual objects are at least 24 hours old. It caps listing work and records
object counts, not misleading “build counts.” Both maintenance actions write
an atomic receipt before remote work and update it on SIGINT/SIGTERM. Rollback
records `not-attempted`, `unconfirmed`, or `confirmed` pointer outcome; a
cancelled command can still have a confirmed completed operation. Always inspect
the receipt before repeating an action.

Cleanup summaries contain `listed`, `protected`, `unreferenced`, `eligible` and
`deleted` groups. Each has `objects`, `knownBytes`, and `unknownSizeObjects`;
unknown phases are `null`. Known bytes are a lower bound if sizes are missing.
A failed deletion has an unknown deleted result because S3 may partially succeed.
These figures cover `builds/{model}/`; shared coverage and qualification
namespaces are outside that accounting. The monitor observes recent maintenance
failures per environment/action as backlog signals; it does not claim a live
bucket-cost measurement. Shared coverage garbage collection
is deferred; it must not infer safety from one model's pointer. Bucket lifecycle
rules must not independently delete referenced data.

Any credential use outside these workflows is break-glass administration:
disable both writer workflows, wait for running jobs to exit, record the action,
and restore the supported authority afterward. A CLI argument cannot prove
exclusion from an unknown external writer. Never copy GitHub secrets into logs.

## Qualification commands

`pnpm capacity` reports admitted work and the current product’s complete working-set estimate before acquisition; hypothetical fleet/storage projections are labeled separately. Use `--help` on the
acquisition/build comparison tools for pinned inputs and cache controls.
`scripts/compare-builds.ts` compares every packed byte and every decoded tile
address. `scripts/benchmark-api.ts --load` performs the declared five-minute
paced load; short runs remain explicitly unqualified. See [execution evidence](foundation-execution.md)
for measured decisions and outstanding release gates.
