# Operations

Run production changes through GitHub Actions on current `main`. Start with
`staging`; use `production` after checking the map, samples and Windy plugin.
Forecast and maintenance jobs for the same environment and model wait for each
other. Different models can build and publish independently. Keep write
credentials in GitHub.

## Set up an environment

Store the shared `CLOUDFLARE_ACCOUNT_ID` as a repository secret. Create protected
`staging` and `production` GitHub environments with:

- Secrets: `CLOUDFLARE_API_TOKEN`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`. Scope R2 credentials to that
  environment's bucket. Deployment needs Workers Scripts Edit and Pages Edit.
- Variables: `API_BASE_URL` and `PAGES_PROJECT_NAME` for that environment.
  The bucket comes from its `BUCKET` binding in [Wrangler configuration](../apps/api/wrangler.json).

Create resources once with an authenticated Wrangler session. For staging:

```sh
pnpm exec wrangler r2 bucket create windy-av-layer-staging
pnpm exec wrangler r2 bucket dev-url disable windy-av-layer-staging
pnpm exec wrangler r2 bucket domain list windy-av-layer-staging
pnpm exec wrangler pages project create windy-av-preview-staging --production-branch main
```

Use the production bucket and Pages project names when setting up production.
Skip creation for existing resources. Keep `r2.dev` disabled and attach no public
custom domains to either bucket. Record the Pages project's canonical hostname;
Cloudflare may add a suffix when a name is already in use.
Then publish a forecast before deploying the API and clients. In a new
environment without an API, the files commit successfully but the serving check
fails. Confirm `publication.json` records the commit, deploy the API and clients,
then [resume that saved build](#resume-or-promote-a-build) to complete serving
verification. The forecast does not need to be rebuilt.

## Publish a forecast

Choose **all**, **gfs**, or **icon-eu** in the Forecast workflow's model dropdown,
or run:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=all
```

`all` is the default and expands to the registered models. Without `cycle`, each
model discovers its latest complete run independently. To select one shared
initialization time, add `-f cycle=YYYY-MM-DDTHH:00:00Z`; both current models
accept 00, 06, 12 or 18 UTC. Production runs all models automatically at
**05:17 and 17:17 UTC**. A model skips a cycle already published, and successful
publication is followed by cleanup.

Selected models run concurrently as GitHub runners and account limits allow.
Each runs `forecast-plan`, up to four parallel `forecast-shard` jobs, then
`forecast` to assemble and publish. Planning fixes that model's cycle and frame
list, including its daylight filtering. Job names list the actual `fXXX` hours in
each batch; the planning summary also shows their UTC valid times. GFS and ICON-EU
can have different cycles, hour lists, and batch sizes.

Each model holds its own environment/model lock through planning, computation,
publication, and cleanup. A single-model dispatch and an `all` dispatch therefore
cannot publish the same model concurrently. A failed model or batch does not
cancel the other model. GitHub collects only artifacts in that model and plan's
namespace; finalization rejects missing or extra groups and checks their
identities and hashes. Compute workers have no R2 publication credentials.

The model selector has a five-minute limit. Each model allows 15 minutes for
planning, 60 minutes per concurrent worker, and 60 minutes for assembly and
publication. These job timeouts do not replace the measured build budget below.

Each worker's receipt and failure/progress records are retained separately. A failed
worker prevents publication; successful worker artifacts can be reused by GitHub's
rerun-failed-jobs action if assembly can still finish within the original plan's
50-minute elapsed-time budget. Worker startup, transfers and retry delays count
toward that budget. Start a fresh run after it expires. The separate six-hour
publication lifetime still applies to completed-build resume. A fresh planning
attempt creates a separate artifact set, so workers from
different plans cannot be combined. Complete-build resume below remains the recovery
path after assembly or upload failures.

Publishing requires a source cycle at most **18 hours old**, at least **six
hours of forecast remaining**, and a build created within the last **six hours**.
Files are retained for seven days; that does not make old weather current.
An older source cycle cannot replace a newer one through normal publication.

If you deliberately want another build of the current cycle, add
`-f allow-same-cycle=true`. To keep complete files after a successful run, add
`-f retain-full-artifacts=true`. Build budgets are checked before publication;
use `pnpm capacity` when planning changes to the workload.

## Resume or promote a build

Use the original run's complete build files to retry without rebuilding tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=RUN_ID
```

Resume needs a finished run with one complete saved build for each selected
model. Use `model=all` when that run retained complete artifacts for every
registered model; each resumes independently from its own artifact. If only one
model needs recovery, select it explicitly. A missing or incomplete artifact
fails that model's resume without rebuilding it or cancelling another model.
The six-hour limit starts when the build was created, not when its upload failed.
The current build code and configuration must still match, and the freshness
rules above still apply. Otherwise, start a fresh forecast.

Resume checks the files and source workflow before uploading. It reuses matching
remote files and can recover an upload whose final result was uncertain. A
same-cycle replacement still needs `allow-same-cycle=true`. Rerunning the original
job replaces that run's saved artifacts, so check them before choosing its ID.

To promote tested staging data, build it with `retain-full-artifacts=true`, then
use that successful run's ID in the same resume command with
`environment=production`. This uploads the exact tested files; it does not build
another forecast. The same code, configuration and freshness checks apply.

## Deploy the API and clients

```sh
gh workflow run deploy.yml --ref main -f environment=staging
```

Deployment runs CI, builds the clients, deploys the Worker, checks the live API,
and then deploys Pages. It checks that both services serve the requested version,
and that the Windy bundle is readable from Windy and points to the selected API.

A forecast publication does not rebuild Pages. The map loads the selected model's
latest manifest, layers, and hours when opened or when a model is selected.
Reload an open browser page to see a new publication; the API's
[pointer cache](serving-budgets.md) can delay discovery by up to 15 seconds.

The publisher checks that the live API serves the exact new build and its
frame/layer lists, with a one-minute deadline for cache refresh. `serving.json`
records the result. This verifies API data visibility; Pages deployment and
rendered UI checks are separate.

Pushes to `main` normally deploy production automatically. For an incompatible
alpha release, pause that workflow before merging, publish matching data, then
re-enable deployment and check staging before production. Keep a usable previous
build available for rollback. A run rejects a superseded `main` revision; start
another run from current `main` if that happens.

## Roll back or clean up

The Maintenance model dropdown lists individual models. Rollback requires one
model's retained build ID, so there is no `all` option. Choose a retained,
unexpired build that still covers useful forecast times:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=rollback -f build-id=RETAINED_BUILD_ID
```

Rollback checks the saved files before changing the served build. To remove
unused builds without changing the current forecast:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=cleanup
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
is still eligible. A cleanup or serving-check failure after `committed` does not
undo publication. `serving.json` identifies a publication that the API could not
yet serve; check the API deployment and run Forecast health before rebuilding.
`maintenance.json` records rollback or cleanup results; inspect it before
repeating a cancelled operation, which may already have completed.

The hourly [health workflow](https://github.com/jdorrance/av-layers/actions/workflows/health.yml)
checks every registered model's live forecast and recent jobs. Its model dropdown
also supports `all`. Each model gets an independent check and artifact; an ICON-EU
failure in an all-model run does not mark a successful GFS publication as failed.
Enable GitHub failure notifications. For models that omit nighttime hours, the
horizon warning follows the source forecast window. Health still alerts when
the published daylight hours run out; publication validates that no expected
daylight hours are missing.

Production checks scheduled-run recency separately from publication results.
A successful manual retry clears a publisher failure; it does not clear a missed
schedule. Staging checks its own labelled runs and has no scheduled-run requirement.

- **Missed schedule or publication:** inspect the latest forecast run and whether
  the workflow is enabled. If it was disabled unintentionally, run
  `gh workflow enable forecast.yml`, then publish a fresh forecast through the
  command above. Check actual runs as well as cron; schedules can be delayed.
- **Upstream lag, shrinking horizon or expiry:** check for a complete source run,
  then publish it. Editing an old build's expiry does not refresh its weather.
- **Serving integrity:** compare the deployed version and forecast files. Restore
  a compatible retained build or deploy matching code and fresh data.
- **Publisher or maintenance failure:** inspect `publication.json`, `failure.json`
  and `maintenance.json` before retrying. Resume an eligible interrupted upload;
  rerun serialized cleanup for a failed cleanup or backlog.
- **Workflow observation failure:** check GitHub API availability and the health
  job's `actions: read` permission before rerunning it.

After recovery, rerun the check for the affected environment:

```sh
gh workflow run health.yml --ref main -f environment=staging -f model=gfs
gh run list --workflow health.yml --limit 5
```

Workflows call `pnpm operations` internally. For local work, see
[Development](development.md). For implementation details, see
[Architecture](architecture.md), [operations](../scripts/operations.ts), and
[publication](../apps/batch/src/publication.ts).
