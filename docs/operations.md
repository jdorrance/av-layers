# Operations

Run production changes through GitHub Actions on current `main`. Start with
`staging`; use `production` after checking the map, samples and Windy plugin.
Forecast and maintenance jobs wait for each other, so only one changes an
environment's published data at a time. Keep write credentials in GitHub.

## Set up an environment

Create protected `staging` and `production` GitHub environments with these values:

- Secrets: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`,
  `CLOUDFLARE_BOOTSTRAP_TOKEN`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`. The two account IDs must match. Scope R2 credentials
  to that environment's bucket. Normal deployment needs Workers Scripts Edit
  and Pages Edit; resource creation uses the separate bootstrap token.
- Variables: `API_BASE_URL`, `R2_BUCKET`, `PAGES_PROJECT_NAME`. Match the Worker
  and bucket names in [Wrangler configuration](../apps/api/wrangler.jsonc).

Keep the R2 bucket private, with public `r2.dev` and custom-domain access disabled.
For a new environment, run **bootstrap, forecast, then deploy**, in that order:

```sh
gh workflow run bootstrap.yml --ref main -f environment=staging \
  -f confirm=bootstrap-private-cloudflare
```

Wait for bootstrap to finish before publishing the first forecast.

## Publish a forecast

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs
```

Without `cycle`, the builder chooses a complete recent GFS run. To select one,
add `-f cycle=YYYY-MM-DDTHH:00:00Z` using a 00, 06, 12 or 18 UTC cycle.
Production also runs automatically at **05:17 and 17:17 UTC**. Scheduled runs
skip a cycle already published; successful publication is followed by cleanup.

Publishing requires a source cycle at most **18 hours old**, at least **six
hours of forecast remaining**, and a build created within the last **six hours**.
Files are retained for seven days; that does not make old weather current.
An older source cycle cannot replace a newer one through normal publication.

If you deliberately want another build of the current cycle, add
`-f allow-same-cycle=true`. To keep complete files after a successful run, add
`-f retain-full-artifacts=true`. Build budgets are checked before publication;
use `pnpm capacity` when planning changes to the workload.

## Resume an interrupted upload

Use the original run's complete build files to retry without rebuilding tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=RUN_ID
```

Resume needs a finished run with one complete saved build. An early build
failure may not leave enough files to resume.
The six-hour limit starts when the build was created, not when its upload failed.
The current build code and configuration must still match, and the freshness
rules above still apply. Otherwise, start a fresh forecast.

Resume checks the files and source workflow before uploading. It reuses matching
remote files and can recover an upload whose final result was uncertain. A
same-cycle replacement still needs `allow-same-cycle=true`. Rerunning the original
job replaces that run's saved artifacts, so check them before choosing its ID.

## Deploy the API and clients

```sh
gh workflow run deploy.yml --ref main -f environment=staging \
  -f confirm=deploy-read-only-worker
```

Deployment runs CI, builds the clients, deploys the Worker, checks the live API,
and then deploys Pages. It checks that both services serve the requested version.

Pushes to `main` normally deploy production automatically. For an incompatible
alpha release, pause that workflow before merging, publish matching data, then
re-enable deployment and check staging before production. Keep a usable previous
build available for rollback. A run rejects a superseded `main` revision; start
another run from current `main` if that happens.

## Roll back or clean up

Choose a retained, unexpired build that still covers useful forecast times:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=rollback -f build-id=RETAINED_BUILD_ID -f confirm=serialized-maintenance
```

Rollback checks the saved files before changing the served build. To remove
unused builds without changing the current forecast:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=cleanup -f confirm=serialized-maintenance
```

Cleanup protects current and retained builds and applies a 24-hour grace period
to unreferenced files. Let this workflow manage deletion; separate bucket expiry
rules can remove files still in use.

## Check a failure

```sh
gh run list --workflow forecast.yml --limit 5
gh run view RUN_ID --log-failed
```

Download the run's result artifacts from GitHub Actions. `publication.json`
records a published build; `failure.json` distinguishes `not-attempted`,
`unconfirmed`, and `committed`. For `unconfirmed`, resume the exact build if it
is still eligible. A cleanup failure after `committed` does not undo publication.
`maintenance.json` records rollback or cleanup results; inspect it before
repeating a cancelled operation, which may already have completed.

The hourly health workflow checks the live forecast and recent jobs. Enable
GitHub failure notifications. For stale weather, check source availability and
the latest forecast run; for serving errors, check the deployed version and its
forecast files. Schedules can be delayed, so check actual runs as well as cron.

Workflows call `pnpm operations` internally. For local work, see
[Development](development.md). For implementation details, see
[Architecture](architecture.md), [operations](../scripts/operations.ts), and
[publication](../apps/batch/src/publication.ts).
