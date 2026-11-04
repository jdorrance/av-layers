# Operations

Run production and staging operations through GitHub Actions on `main`.
Concurrency locks are scoped per environment and model (`forecast-<env>-<model>`),
so different models build and publish in parallel while same-model runs and
maintenance serialize.

## Set up an environment

Configure repository secret `CLOUDFLARE_ACCOUNT_ID` and create protected
`staging` and `production` GitHub environments with:

- Secrets: `CLOUDFLARE_API_TOKEN` (Workers Scripts Edit + Pages Edit + R2 bucket
  configuration read),
  `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY` with Object Read & Write access
  to that environment's bucket, plus `GH_CREDENTIAL_ISSUER_TOKEN`, a GitHub App
  installation token or fine-grained token with Environments write access to this
  repository. Keep the token current. Prepare creates or updates
  `FORECAST_GFS_SHARD_CREDENTIAL_KEY` and `FORECAST_ICON_EU_SHARD_CREDENTIAL_KEY`
  as environment secrets; precreating them is optional.
- Variables: `API_BASE_URL`, `PAGES_PROJECT_NAME`, and optional
  `TERRAIN_CATALOG_REF` to select a [terrain catalog](#terrain-data). Bucket names come
  from [wrangler.json](../apps/api/wrangler.json).

Create the R2 bucket (with `r2.dev` disabled) and Cloudflare Pages project once
per environment:

```sh
pnpm exec wrangler r2 bucket create windy-av-layer-staging
pnpm exec wrangler r2 bucket dev-url disable windy-av-layer-staging
pnpm exec wrangler r2 bucket lock add windy-av-layer-staging forecast-builds builds/ --retention-days 7
pnpm exec wrangler pages project create windy-av-preview-staging --production-branch main
```

Provision the same `builds/` lock for production. Prepare checks the existing
bucket lock through the Cloudflare API before issuing credentials; it never
changes the rule. Keep the rule enabled throughout each build and its retention.

For a new environment, run the Forecast workflow (which commits to R2 before
the serving check), deploy the API and
Pages, then [resume that build](#resume-a-build) to complete serving
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

Each selected model runs `forecast-terrain` (60m job timeout), `forecast-plan`
(15m timeout), up to four parallel `forecast-shard` jobs (60m timeout), and
`forecast` (`build-publish`, 60m timeout) to assemble, validate, publish to R2,
clean up expired builds, and verify live API serving. Terrain preparation has its
own 50-minute operation budget; forecast elapsed time starts with planning. If a
shard fails, `gh run rerun <run_id> --failed` reuses completed shard artifacts while
the plan remains within the 50-minute build elapsed-time budget and its environment
secret has not been rotated by a later same-model build. After rotation, start a
new build.

`forecast-terrain` prepares a missing R2 cache or validates the existing arrays,
reporting progress in the job log. Planning requires that cache; a missing cache
fails planning immediately.

The prepare job signs [temporary R2 credentials](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/)
and encrypts them with a fresh per-build AES-256-GCM key in the plan artifact,
bound to the bucket, model, build ID and deadline. Shards receive only their
model's environment key. Terrain preparation, planning and publication receive
the parent R2 credentials. The write credential permits `PutObject` under its build prefix; the
read credential permits `GetObject` and `HeadObject` under that prefix,
`coverage/`, and `terrain/prepared/`. Both expire at the plan deadline or after
one hour, whichever comes first. Protect the encryption key and plan artifact as
credentials until expiry.
GitHub reads [environment secrets when a job starts](https://docs.github.com/en/actions/reference/security/secrets#when-github-actions-reads-secrets).
The `needs: prepare` barrier starts shards after key rotation. The
per-environment, per-model concurrency lock holds until the model workflow ends,
preventing another same-model build from rotating its key while shards run.
Shard GitHub tokens have `contents: read` and cannot download
artifacts from other runs; current-run artifact delivery uses the Actions runtime.

Planning uploads coverage and prepared terrain to R2 and records their receipts
in the frozen plan. Workers stage verified terrain from R2 and derive fine lift
surfaces from the same native weather frames. Assembly requires every grid's
complete shard set before validating and publishing the build.

Admission requires a source cycle at most **18 hours old**, at least **6 hours
of remaining forecast coverage**, and a build created within the last **6 hours**.
Published builds are retained for 7 days.
Bucket locks retain each object for at least seven days from its upload, so
cleanup may encounter protected objects for up to the 50-minute build budget
after build expiry. A locked multi-object delete reports an error and cleanup
can have partial progress; retry cleanup after the affected objects unlock.

## Resume a build

Resume a retained build in its original environment without rebuilding tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=RUN_ID
```

Resume verifies the source workflow run on `main`, checks recipe and coverage
hashes, verifies remote receipts or uploads retained local payloads, commits the
pointer within the original build deadline, and verifies live serving. After the
deadline, resume completes maintenance and serving checks for the committed
latest build.

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

Production forecasts use the catalog pinned in the
[model workflow](../.github/workflows/forecast-model.yml). Both weather models
use this catalog and the shared
[polygon configuration](../packages/contracts/config/refinement.json).

The Forecast workflow's `terrain-catalog-ref` input overrides the environment's
`TERRAIN_CATALOG_REF`, which overrides the production pin. For staging, set the
variable to the complete JSON reference in that environment's import artifact,
`terrain-catalog-ref.json`. The catalog and tiles must exist in the selected
environment's bucket. Configured whole-domain products require a catalog.
Catalog selection binds terrain preparation and cache validation; workers use
the frozen plan. Changes to source data, grid, coverage or preparation method
select a new terrain cache. Missing or corrupt assets fail the terrain job.

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
