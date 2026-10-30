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
membership has a bounded cap in the [shared contract](../packages/contracts/src/index.ts);
publication refuses overflow instead of dropping live builds. `pnpm capacity`
checks cadence against retention, including headroom for replacement builds.

<details>
<summary>What upload verification establishes</summary>

Local artifacts are checked with SHA-256. Uploads use single-part PUTs with
`Content-MD5`, at most four concurrently and within the publisher's byte budget.
Oversized artifacts fail before allocation or upload. Readback checks size, the expected MD5
ETag and a 32-byte tail with matching ETag; the complete manifest is read back.
Multipart or opaque ETags are rejected. This relies on R2 validating MD5 and
faithfully reporting stored-object ETags. It is not an independent remote
SHA-256 scrub and cannot detect corrupt bytes hidden behind dishonest or stale
backend metadata.

The forecast workflow builds and publishes in one process. It reuses a successful
validation result only while its manifest contents and output root are unchanged;
it still hashes every byte actually uploaded. Standalone `publish` performs full
validation. No receipt file, path, timestamp or caller-supplied digest can bypass
that validation.

</details>

## First deployment

Everything after setup runs in GitHub Actions; no local release commands are
needed. Complete these one-time steps before the first release:

1. Enable Cloudflare billing. Create a separate **bootstrap** API token with R2
   Admin and Pages Edit, and store it as `CLOUDFLARE_BOOTSTRAP_TOKEN` in both
   GitHub environments. The deploy token (`CLOUDFLARE_API_TOKEN`) needs Workers
   Scripts Edit and Pages Edit only. Keep it separate from the bootstrap token.
   Account-owned and user-owned API tokens are both supported.
2. In GitHub, create `staging` and `production` environments with protection
   rules. Add `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` as secrets and
   set these variables per environment: `API_BASE_URL`, `R2_BUCKET`,
   `PAGES_PROJECT_NAME`. `R2_BUCKET` must match the selected environment in
   [Wrangler configuration](../apps/api/wrangler.jsonc). The staging Pages
   project name must end in `-staging`; the production name must not, so a
   staging deploy cannot overwrite production.
3. Run **Bootstrap Cloudflare resources** from `main` with
   `bootstrap-private-cloudflare`. It creates the private R2 bucket and the
   Pages project on `main`, and refuses to continue if the bucket is public.
   The command is idempotent and never disables a public bucket for you.
4. Create an R2 S3 access key scoped to that bucket only with Object Read &
   Write. Add `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` to the
   matching GitHub environment. They are only needed after the bucket exists.
5. Set `API_BASE_URL` to the target Worker URL. For the default `workers.dev`
   URL it must start with the Wrangler environment name, for example
   `https://windy-av-api-staging.<your-subdomain>.workers.dev`. The deployment
   refuses a staging URL that names the production Worker.
6. Run **Forecast sample** for the environment so the API has an initial
   published build. It fails before building if any required secret or variable
   is missing.
7. Run **Deploy Worker and Pages** for the environment. Its mandatory smoke
   check fails on an empty bucket with a 503 and repeats the order above.

The order is **Bootstrap → Forecast sample → Deploy Worker and Pages**. After
the first release, pushes to `main` run CI and then deploy automatically, and
the forecast workflow runs at `05:17` and `17:17 UTC` for production. These
twelve-hour updates overlap the normal 24-hour forecast horizons, with room for
the workflow timeout. Monitor horizon exhaustion for upstream or scheduling
delays; this cadence is not an availability guarantee.

Each release or maintenance workflow checks for a newer `main` commit at start.
The forecast workflow repeats the check after building, immediately before
publication. These checks are not atomic with branch updates: `main` can advance
after a check while the current run continues. Forecast builds are immutable and
the pointer swap is compare-and-swap, so the result remains a complete,
validated build rather than a partially written one.

## Deploy and schedule

The deployment job gives the Worker a commit/run/attempt marker and requires
`API_BASE_URL` to return that exact marker from its uncached `/healthz` response.
This catches an API URL pointing at another environment, account, or deployment
before the map is built or published. Local runs can omit the marker.

The job then builds the map with that API URL, verifies the Pages project still
uses `main` as its production branch, deploys, and checks the same embedded
marker at the canonical Pages URL. Revision checks retry temporary network
failures with a deadline covering both connection and response body. That URL comes from
Cloudflare's project record, preserving any suffix assigned when a project name
was already taken; the deployment summary links to the same URL. Deployment runs
automatically on `main` and can be dispatched for either environment. The Worker
needs no forecast-provider credentials and exposes no write, admin or job routes.

`AV_LOCAL_DEVELOPMENT=true` is reserved for local Wrangler: it allows the local
sampling limiter to work without Cloudflare's client-IP header. Production
fails closed when that header or the limiter is unavailable.

The [forecast workflow](../.github/workflows/forecast.yml) owns cadence, timeout
and per-model serialization. It validates the environment's publisher
credentials and bucket mapping before spending time on acquisition, then builds,
validates, checks [resource budgets](../apps/batch/src/capacity.ts), and publishes. Missing credentials fail the run rather than reporting
a green skipped publication. A rerun creates a fresh build. GitHub schedules can
be delayed or disabled; recover with manual dispatch and an explicit cycle.


## Monitor and recover

Check catalog availability and the latest forecast horizon (`horizonExhausted`)
separately from retention expiry; `/healthz` proves
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

For capacity planning, `pnpm capacity --cadence-hours 1 --frames 16 --layers 6`
reports tile work, numeric storage, point-read size and retained builds. It exits
unsuccessfully when a proposed workload exceeds admission limits. Retained bytes
exclude archives, replacements and failed uploads; add their measured sizes.
Keep cleanup serialized with publishers; lifecycle deletion and more frequent
scheduling are not free substitutes for that protocol.
