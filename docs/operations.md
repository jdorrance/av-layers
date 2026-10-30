# Operations

The operating model is one batch CLI, one private R2 bucket per environment,
and one read-only Worker. Start with a [validated local build](getting-started.md).
[Status](status.md) distinguishes local evidence from remote release proof.

## Publish a build

Create the environment's bucket and disable public `r2.dev` and custom-domain
access. Clients read through the Worker; raw acquisition caches stay local.
Publication credentials need Object Read & Write on that bucket, without
account-wide administration:

```sh
export R2_ACCOUNT_ID='...'
export R2_ACCESS_KEY_ID='...'
export R2_SECRET_ACCESS_KEY='...'
export R2_BUCKET='...'
AV_MANIFEST=output/builds/gfs/BUILD_ID/manifest.json
pnpm run publish --manifest "$AV_MANIFEST"
```

Replace the placeholders with your credentials and manifest path. Keep secrets
outside the repository. The [publisher](../apps/batch/src/publication.ts) validates
the build and uploads create-only artifacts, followed by the manifest. It then
conditionally replaces the model's latest pointer using the ETag captured before
upload: compare-and-swap, or CAS. A competing publisher's success causes this
attempt to abort; it does not overwrite the winner. Failed uploads leave latest
unchanged. Build IDs are never reused.

Publication refuses older cycles, expired builds and builds more than six hours
old. Use `--allow-same-cycle` only for an intentional method replacement. Retained
membership is capped at 128 builds; publication refuses overflow instead of
dropping live builds.

<details>
<summary>What upload verification establishes</summary>

Local artifacts are checked with SHA-256. Uploads use single-part PUTs with
`Content-MD5`, at most four concurrently. Readback checks size, the expected MD5
ETag and a 32-byte tail with matching ETag; the complete manifest is read back.
Multipart or opaque ETags are rejected. This relies on R2 validating MD5 and
faithfully reporting stored-object ETags. It is not an independent remote
SHA-256 scrub and cannot detect corrupt bytes hidden behind dishonest or stale
backend metadata.

</details>

## Deploy and schedule

[Wrangler configuration](../apps/api/wrangler.jsonc) owns bucket bindings,
rate limits and environment names. Configure those resources and use Workers
Paid for production headroom. From the repository root:

```sh
export CLOUDFLARE_ACCOUNT_ID='...'
export CLOUDFLARE_API_TOKEN='...'
pnpm run deploy:staging
pnpm exec tsx scripts/smoke-api.ts --base-url https://STAGING_HOST --model gfs
```

After staging verification, use `pnpm run deploy:production` and run the smoke
check separately against the production host. The
[manual deployment workflow](../.github/workflows/deploy.yml) also supports both
environments, requires its confirmation input, and runs a deployed smoke check
when `API_BASE_URL` is configured. The Worker needs no forecast-provider
credentials and exposes no write, admin or job routes.

`AV_LOCAL_DEVELOPMENT=true` is reserved for local Wrangler: it allows the local
sampling limiter to work without Cloudflare's client-IP header. Production
fails closed when that header or the limiter is unavailable.

The [forecast workflow](../.github/workflows/forecast.yml) owns cadence, timeout
and per-model serialization. It uses the same CLI and publishes only when all
four R2 secrets exist; otherwise it records skipped publication after local
validation. A rerun creates a fresh build. GitHub schedules can be delayed or
disabled; recover with manual dispatch and an explicit cycle, or the same CLI
on one cron runner.

## Monitor and recover

Check catalog availability and latest `ageSeconds`/`expiresAt`; `/healthz` proves
only service liveness. Check frame times separately for forecast relevance, as
explained in [time and retention](data.md#time-and-retention).
Builds expire after seven days. Cache TTLs are bounded by
expiry, expired requests return `404 not-retained`, and clients stop displaying
expired builds. Worker caching is per edge location; every request still invokes
the Worker. Consult its `/docs` and `/openapi.json` for details.

Before rollback or cleanup, pause **every** publisher and cancel or wait for
active runs. Then use the [maintenance workflow](../.github/workflows/maintenance.yml)
with its confirmation input, or run:

```sh
pnpm run rollback --model gfs --build-id RETAINED_BUILD_ID --publishers-paused
pnpm run cleanup --model gfs --publishers-paused
```

Rollback verifies a retained, unexpired target before CAS. Cleanup rereads retained
references and deletes only unreferenced builds whose IDs and objects are at
least 24 hours old. Current and retained rollback targets remain protected;
bucket lifecycle rules must not independently delete referenced data. Verify the
selected build, then explicitly resume scheduling.

Measure acquisition bytes and stage timings, peak memory/disk, artifact sizes,
R2 operations and storage, Worker CPU/cache hits, and cold versus warm tile/sample
latency. Include runner and Worker costs. Use recorded representative networks
before claiming latency targets or savings; adjust scope or cadence from measured
results. [Development](development.md) describes validation and evidence collection.
