# Operations

Run production and staging operations through GitHub Actions on `main`.
Concurrency locks are scoped per environment and model (`forecast-<env>-<model>`),
so different models build and publish in parallel while same-model runs and
maintenance serialize.

## Set up an environment

Configure repository secret `CLOUDFLARE_ACCOUNT_ID` and create protected
`staging` and `production` GitHub environments with:

- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit + Pages Edit),
  `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` scoped to that environment's
  bucket.
- Variables: `API_BASE_URL`, `PAGES_PROJECT_NAME`, and optional
  `TERRAIN_CATALOG_REF` to enable [terrain refinement](#terrain-data). Bucket names come
  from [wrangler.json](../apps/api/wrangler.json).

Create the R2 bucket (with `r2.dev` disabled) and Cloudflare Pages project once
per environment:

```sh
pnpm exec wrangler r2 bucket create windy-av-layer-staging
pnpm exec wrangler r2 bucket dev-url disable windy-av-layer-staging
pnpm exec wrangler pages project create windy-av-preview-staging --production-branch main
```

For a new environment, run the Forecast workflow (which commits to R2 before
the serving check), deploy the API and
Pages, then [resume that build](#resume-or-promote-a-build) to complete serving
verification.

## Publish a forecast

Choose **all**, **gfs**, or **icon-eu** in the Forecast workflow, or run:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=all
```

`all` expands to `MODEL_IDS` (`gfs`, `icon-eu`). Production runs `all` on
schedule at **05:17 and 17:17 UTC**. Without `cycle`, each model discovers its
latest complete upstream run (`00`, `06`, `12`, or `18` UTC). Already-published
cycles are skipped unless `-f allow-same-cycle=true` is passed. Pass
`-f retain-full-artifacts=true` to retain full build artifacts after a
successful run.

Each selected model runs `forecast-plan` (15m timeout), up to four parallel
`forecast-shard` jobs (60m timeout), and `forecast` (`build-publish`, 60m
timeout) to merge, validate, publish to R2, clean up expired builds, and verify
live API serving. If a shard fails, `gh run rerun <run_id> --failed` reuses
completed shard artifacts while the plan remains within the 50-minute build
elapsed-time budget.

Planning stages each configured grid's coverage and terrain arrays in the frozen
plan artifact. Workers load them locally and derive patches from the same native
weather frames. Assembly requires every grid's complete shard set before
validating and publishing the build.

Admission requires a source cycle at most **18 hours old**, at least **6 hours
of remaining forecast coverage**, and a build created within the last **6 hours**.
Published builds are retained for 7 days.

## Resume or promote a build

Retry an interrupted upload or promote a retained staging build (`retain-full-artifacts=true`)
without rebuilding tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=RUN_ID
```

Resume verifies the source workflow run on `main`, checks recipe and coverage
hashes, uploads any missing R2 objects, commits the pointer, and verifies live
serving.

Refined builds retain `plan.json` with their full artifacts. Resume checks its
original grid and terrain references against the manifest and recipe; it does
not resolve current catalog defaults or prepare terrain again.

## Deploy the API and clients

```sh
gh workflow run deploy.yml --ref main -f environment=staging
```

Pushes to `main` deploy production automatically. `deploy.yml` runs CI, builds
`@av/preview` and `@av/windy-plugin`, deploys the API Worker, probes `/healthz`
and `/v1/catalog`, deploys Cloudflare Pages, and verifies the deployed revision
marker and Windy plugin CORS headers.

Clients fetch the selected model's latest manifest from the API on load or model
switch; reload the page to pick up a newly published build (subject to the API's
15-second [pointer cache](serving-budgets.md)).

## Roll back or clean up

Point a model back to an unexpired retained build:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=rollback -f build-id=RETAINED_BUILD_ID
```

Delete unreferenced build objects older than the 24-hour grace period:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=cleanup
```

## Terrain data

Run the [Global terrain workflow](../.github/workflows/terrain.yml) from `main`
to import and verify the Copernicus GLO-90 catalog in R2. See the
[terrain guide](../apps/batch/src/terrain/README.md) for CLI commands and grid
preparations.

Deploy compatible API and clients, then set the environment's `TERRAIN_CATALOG_REF`
variable to the complete JSON
reference in the import's `terrain-catalog-ref.json` artifact. The catalog and
tiles must exist in that environment's bucket. Both weather models use this pin
and the shared [polygon configuration](../packages/contracts/config/refinement.json).

The Forecast workflow's `terrain-catalog-ref` input overrides the default for
one run and reaches only the preparation job. Without a catalog setting,
forecasts use their native grids. A supplied missing or corrupt catalog fails
preparation. Empty or out-of-domain zone configurations keep native output.

The existing `terrain-inputs` model map remains available for staging prepared
native-grid arrays alongside configured refinements.

## Check a failure

```sh
gh run list --workflow forecast.yml --limit 5
gh run view RUN_ID --log-failed
```

Inspect the run's uploaded receipt artifacts:

- `publication.json`: records a committed pointer update.
- `failure.json`: reports `not-attempted`, `unconfirmed`, or `committed`. Resume
  `unconfirmed` runs with `resume-run-id`.
- `maintenance.json`: records cleanup or rollback status.
- `serving.json`: records live API verification after commit.

The hourly [health workflow](https://github.com/jdorrance/av-layers/actions/workflows/health.yml)
checks each model's live API responses, remaining horizon, and recent workflow
runs:

- **Missed schedule or publication:** verify `forecast.yml` is enabled and
  trigger a run if needed.
- **Upstream lag, shrinking horizon, or expiry:** publish a newer upstream cycle.
- **Serving integrity:** check Worker deployment and retained R2 build objects,
  or roll back to a verified retained build.
- **Publisher or maintenance failure:** inspect `publication.json`,
  `failure.json`, and `maintenance.json`; resume interrupted uploads or rerun
  `cleanup`.
- **Workflow observation failure:** check GitHub API status and `actions: read`
  permissions.

Re-verify after recovery:

```sh
gh workflow run health.yml --ref main -f environment=staging -f model=gfs
gh run list --workflow health.yml --limit 5
```
