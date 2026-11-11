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
  to that environment's bucket, and a distinct 32-byte hexadecimal
  `FORECAST_SHARD_CREDENTIAL_KEY` for each environment.
- Variables: `API_BASE_URL`, `PAGES_PROJECT_NAME`, and optional
  `TERRAIN_CATALOG_REF` to select a [terrain catalog](#terrain-data). Bucket names come
  from [wrangler.json](../apps/api/wrangler.json).

Create the R2 bucket (with `r2.dev` disabled) and Cloudflare Pages project once
per environment:

```sh
pnpm exec wrangler r2 bucket create windy-av-layer-staging
pnpm exec wrangler r2 bucket dev-url disable windy-av-layer-staging
pnpm exec wrangler r2 bucket lock add windy-av-layer-staging forecast-builds builds/ --retention-days 7
pnpm exec wrangler r2 bucket lifecycle add windy-av-layer-staging forecast-build-expiry builds/ --expire-days 8
pnpm exec wrangler r2 bucket lifecycle add windy-av-layer-staging terrain-checkpoint-expiry terrain/checkpoints/ --expire-days 7
pnpm exec wrangler pages project create windy-av-preview-staging --production-branch main
```

Provision the same lock and lifecycle rules for production. Prepare checks the existing
bucket lock through the Cloudflare API before issuing credentials; it never
changes the rule. Keep the rule enabled throughout each build and its retention.

For a new environment, run the Forecast workflow (which commits to R2 before
the serving check), deploy the API and
Pages, then [resume that build](#resume-a-build) to complete serving
verification.

## Publish a forecast

Enter a configured model ID or **all** in the Forecast workflow:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=all
```

`all` selects models with a configured schedule. An explicit model ID selects
one model. [models.json](../packages/contracts/config/models.json) owns schedules,
forecast windows, rendered zoom and parallelism. Tune that entry, then run
`pnpm docs:generate`, `pnpm verify` and `pnpm capacity --model MODEL`.
Generated workflow triggers select models by the cron expression that fired,
including delayed starts. Manual runs finish each model before starting the next;
scheduled runs start selected models concurrently. Without `cycle`, each model
discovers its latest complete upstream run. Already-published
cycles are skipped unless `-f allow-same-cycle=true` is passed. External cycle
events require a registered event-driven model, an environment, and an explicit
UTC cycle. Pass
`-f retain-full-artifacts=true` to retain full build artifacts after a
successful run.

Each selected model runs `forecast-terrain` (160m job timeout), `forecast-plan`
(15m timeout), parallel `forecast-shard` jobs (60m timeout), and
`forecast` (`build-publish`, 60m timeout) to assemble, validate, publish to R2,
clean up expired builds, and verify live API serving. Terrain preparation has its
own operation budget per attempt from [build budgets](../apps/batch/src/capacity.ts);
forecast elapsed time starts with planning.

Each model's `forecast.window` supplies its selected hours and `framesPerShard`.
The registry derives the shard
target from their frame count; set `framesPerShard` to 1 for one selected frame
per job. The [planner](../apps/batch/src/parallel.ts) balances those frames across
the target groups. Publish stages verified scalar inputs on disk and streams
24-frame sample groups through the [merger](../apps/batch/src/sample-pack-v5.ts).
[Compaction admission](../apps/batch/src/serving-groups.ts) checks temporary disk
against free space and bounds memory. It counts new serving outputs and live
downloaded inputs; existing local inputs use hardlinks. Completed groups release
their staged inputs. Profiles retain their compute groups.
Each model and each group sharing a cron expression fit the
job budget. Use the same cron string for models intended to run together. The
global worker default may be overridden per model; CPU and memory admission bounds
actual workers. Plans freeze rendered zoom,
worker ceilings and frame groups for their workers.

Rendered zoom selects a subset of the bundled coverage pyramid. Supported zoom
changes reuse the same terrain cache and preserve retained builds.
The [build budgets](../apps/batch/src/capacity.ts) gate the complete
forecast's native and fine render work before weather acquisition.

If a shard fails, `gh run rerun <run_id> --failed` reuses completed shard artifacts while
the run revision remains current main, the plan meets the
[build elapsed budget](../apps/batch/src/capacity.ts),
its scoped credentials and the environment sealing key remain valid. After a main change, expiry or rotation, start
a new build.

`forecast-terrain` prepares a missing R2 cache or validates the existing arrays,
reporting progress in the job log. Planning requires that cache; a missing cache
fails planning immediately.

Cold preparation stages verified source files in a bounded local cache and
commits each completed window to R2. `forecast-terrain` retries transport failures
and operation deadlines up to three attempts, reusing verified windows and the
local cache. Integrity and configuration failures stop immediately. The
[terrain CLI](../apps/batch/src/terrain/README.md#use-in-forecasts)
can prepare and upload the same arrays locally.

The prepare job signs [temporary R2 credentials](https://developers.cloudflare.com/r2/examples/authenticate-r2-temp-credentials/)
and seals them with the environment key and a fresh nonce. The envelope binds
the bucket, model, build ID, and deadline. Shards receive the sealed envelope and
the sealing key. Their credentials grant reads under the build, coverage, and
prepared terrain prefixes and conditional writes under the build prefix.
The credentials expire by the [build deadline](../apps/batch/src/capacity.ts).
Rotate the environment key between runs.

The bootstrap artifact carries the plan, envelope, and frozen coverage files.
The coordinator writes the plan and completed shard receipts under the build's
`_control/` prefix in R2. Publication reads and checks those receipts directly.
A retried shard can reuse its completed receipt while its plan is valid.
The build retention and cleanup rules include these control objects.

Planning uploads coverage and prepared terrain to R2 and records their receipts
in the frozen plan. Workers stage verified terrain from R2 and derive fine lift
surfaces from the same native weather frames. Assembly requires every grid's
complete shard set before validating and publishing the build.

[Publication admission](../apps/batch/src/publication.ts) checks configured source
age, useful rendered-map horizon and build lifetime. Source age and minimum
horizon come from [models.json](../packages/contracts/config/models.json).
Published builds are retained for 7 days.
Cleanup waits until every object in an unreferenced build has aged seven days,
matching the `builds/` bucket lock. Scalar source inputs share that retention;
the build cleanup and lifecycle remove them with the other build objects.

R2 independently expires `builds/` objects eight days after upload and
`terrain/checkpoints/` after seven days, including when workflows stop.
Keep the default seven-day multipart-abort rule. Cloudflare typically deletes
expired objects within 24 hours; see [object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles/).
Terrain catalogs, source COGs, prepared arrays, coverage and model pointers have
no age-based expiry; later forecasts reuse them.

## Resume a build

Resume a retained build in its original environment without rebuilding tiles:

```sh
gh workflow run forecast.yml --ref main -f environment=staging -f model=gfs \
  -f resume-run-id=RUN_ID
```

Resume downloads the compact forecast artifact, verifies the source run on
`main`, checks recipe and coverage hashes, verifies remote receipts, and
commits the pointer within the original build deadline. After the deadline,
resume completes maintenance and serving checks for the committed latest build.

The compact artifact includes the frozen `plan.json`, coverage files and terrain
descriptor used to verify the publication.

## Deploy the API and clients

```sh
gh workflow run deploy.yml --ref main -f environment=staging
```

Pushes to `main` deploy production automatically. `deploy.yml` runs CI, builds
the clients, deploys the API Worker, and verifies each configured model's latest
build through the catalog, retained list, point, provenance and tile routes.
After Cloudflare Pages deploys, the job checks the revision marker and Windy
plugin CORS headers.

The Worker and browsers serve v5. Publish a fresh v5 forecast for each model
when cutting over an environment with older builds, then rerun deployment if
the serving probe stopped it. Existing v5 pins remain readable through expiry.

Clients fetch the selected model's latest manifest from the API on load or model
switch; reload the page to pick up a newly published build (subject to the API's
15-second [pointer cache](serving-budgets.md)).

## Roll back or clean up

Point a model back to an unexpired retained build:

```sh
gh workflow run maintenance.yml --ref main -f environment=staging -f model=gfs \
  -f action=rollback -f build-id=RETAINED_BUILD_ID
```

While a build marked `tool.useStoredMslNoLift` remains retained, use a Worker
revision that recognizes the marker. Pointer rollback leaves retained builds
readable by ID.

Delete unreferenced build prefixes whose newest object is at least seven days old:

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
[model workflow](../.github/workflows/forecast-model.yml). All configured weather models
use this catalog for whole-domain terrain preparation (and the shared
[polygon configuration](../packages/contracts/config/refinement.json) for regional patch evaluation).

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
checks each model's live API integrity, configured cycle age, remaining horizon
and expiry. The report records response cache state, storage reads, Worker
timings, and client JSON duration and retries. In Actions, correlate `forecast-stage`,
`forecast-published`, and `forecast-failure` by model, build, run and attempt.

Use the report and artifacts to choose a recovery action.

- **Upstream lag, shrinking horizon, or expiry:** publish a newer upstream cycle.
- **Serving integrity:** check Worker deployment and retained R2 build objects,
  or roll back to a verified retained build.
- **Publisher or maintenance failure:** inspect `publication.json`,
  `failure.json`, and `maintenance.json`; resume interrupted uploads or rerun
  `cleanup`.

Re-verify after recovery:

```sh
gh workflow run health.yml --ref main -f environment=staging -f model=gfs
gh run list --workflow health.yml --limit 5
```
