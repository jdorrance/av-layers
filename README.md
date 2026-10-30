# Windy AV Layer

Three independently sampled forecast layers over one static coverage mask:

- `usable-lift-msl`: usable thermal lift top, metres MSL
- `usable-lift-agl`: the same usable top minus model terrain, metres AGL
- `precip-rate`: interval-mean precipitation rate, mm/h

The project publishes immutable PMTiles archives plus independent numeric sample
arrays into one private R2 bucket. One read-only Hono Worker serves catalog,
manifest, bounded point samples, TileJSON and XYZ PNG tiles.

## Current status and release gaps

This repository is not yet an end-to-end live-data proof. At the time of writing:

- The 2026-10-30 00Z f006 GFS input proof succeeded at three sites after the
  user authorized coalescing exact byte-identical duplicates. All candidate
  ranges are recorded and conflicting bytes remain rejected. This is an input
  proof, not an end-to-end sample build or publication proof.
- A real 24-hour GFS sample build was stopped for the coastal rendering fix; it
  did not complete end to end from this checkout.
- No R2 bucket has been written and no Worker has been deployed.
- No Cloudflare account, bucket, API token or `API_BASE_URL` is configured.
- HRRR, ICON-Armenia, preview and Windy plugin integration have not been proven
  together against a published build.
- Cost, latency, cache-hit and retention numbers in PLAN.md are targets or
  measurement recipes, not measured results. Do not quote them as achieved.
- No LICENSE file was found in windgrams or skyjuice. Their internals are not
  asserted to be MIT or otherwise publicly licensed. See
  `THIRD_PARTY_NOTICES.txt`.

Real-data evidence must be added only after `build:sample`, `validate` and
`smoke-build` run against an actual admissible upstream cycle.

### Verified locally

On 2026-10-30, using the pinned Node 22.23.4/pnpm 10.34.9 wrapper:

- Frozen dependency installation, lint, typecheck, all 219 tests at the latest
  checkpoint (no skips), production preview/plugin builds, Worker bundling and `git diff --check`
  passed. Independent source reviews passed after their findings were corrected.
- Natural Earth mask regeneration completed with pinned GEOS 3.13.1 and PROJ
  9.5.1: 210,237 output cells, 15,950 input-only halo cells, and 402 tile addresses
  across zooms 0–5. Generated files retain their hashes and regeneration metadata.
- A strict f006 acquisition admitted all 53 input records, including all 21 HGT
  and 21 TMP pressure fields. Current and predecessor precipitation duplicates
  were compared as complete GRIB messages and were byte-identical; the normal
  metadata and window checks still applied. Receipts are in
  `output/evidence/gfs-strict-input-proof-f006-guarded-final.json`, covering all
  53 fields, 21 pressure levels and three sites, with complete-byte provenance
  for coalesced duplicates. Earlier diagnostic and strict-uniqueness failure
  evidence remains in `output/evidence/`.
- An actual local Wrangler runtime with an empty R2 bucket returned health and
  OpenAPI successfully, a catalog identifying all models as unavailable, and
  uncached structured 503 errors for unavailable latest/tile requests rather than
  false blank tiles. This is not a populated-publication or deployed-R2 proof.
- Synthetic fixture and built-module tests verify PMTiles orientation/address
  coverage, publication CAS guards, and the Windy loader/URL/expiry lifecycle.
  They do not substitute for the real sample or actual Windy-host validation.

## Pinned toolchain

- Node 22.23.4
- pnpm 10.34.9
- go-pmtiles 1.31.2, pinned per platform by SHA-256

When the host Node is not 22, run commands through the pinned wrapper:

```sh
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm install --frozen-lockfile
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm lint
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm typecheck
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm test
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm build
```

Install and verify the pinned PMTiles CLI:

```sh
node scripts/setup-pmtiles.mjs
.tools/pmtiles version
```

The installer accepts only these release assets, checks the archive SHA-256
before extraction, verifies permissions and `pmtiles version`, then installs
`.tools/pmtiles`:

| Platform | Asset | SHA-256 |
| --- | --- | --- |
| darwin-arm64 | `go-pmtiles-1.31.2_Darwin_arm64.zip` | `40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d` |
| darwin-x64 | `go-pmtiles-1.31.2_Darwin_x86_64.zip` | `1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b` |
| linux-x64 | `go-pmtiles_1.31.2_Linux_x86_64.tar.gz` | `3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f` |
| linux-arm64 | `go-pmtiles_1.31.2_Linux_arm64.tar.gz` | `f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1` |

## Reproducible commands

Input/admission proof (requires upstream network access):

```sh
pnpm run input:proof
pnpm run input:proof --cycle 2026-10-30T00:00:00.000Z --cache-dir .cache/gfs
```

Coverage mask regeneration is a one-off GIS step, not part of scheduled builds:

```sh
pnpm run masks:build
```

Build the real eight-frame GFS sample (`f003` through `f024`):

```sh
pnpm run build:sample --model gfs --out output
pnpm run build:sample --model gfs --out output --cycle 2026-10-30T00:00:00.000Z --cache-dir .cache/gfs
```

Output layout, before publication:

```text
output/builds/gfs/{buildId}/manifest.json
output/builds/gfs/{buildId}/{layer}/{frame}.pmtiles
output/builds/gfs/{buildId}/samples/{layer}/{frame}.bin
```

Validate locally, including PMTiles address/tile coverage and sample layout:

```sh
pnpm exec tsx apps/batch/src/cli.ts validate --manifest output/builds/gfs/{buildId}/manifest.json
pnpm exec tsx scripts/smoke-build.ts --manifest output/builds/gfs/{buildId}/manifest.json
```

Run the operational contract tests. The fixtures under `scripts/fixtures` are
schema-shaped test data only; they are not a published build or live evidence:

```sh
pnpm exec vitest run scripts/operational.test.ts
```

Publication is immutable and uses a conditional latest pointer. It requires
bucket-scoped credentials:

```sh
export R2_ACCOUNT_ID=...
export R2_ACCESS_KEY_ID=...
export R2_SECRET_ACCESS_KEY=...
export R2_BUCKET=...
pnpm run publish --manifest output/builds/gfs/{buildId}/manifest.json
```

Publication validates local SHA-256 digests, uploads at most four files
concurrently using single-part R2 PUTs with `Content-MD5`, and checks object size,
MD5 ETag, and an ETag-pinned 32-byte tail before publishing the manifest and
pointer. It does not download complete artifacts for readback. This relies on
R2 validating `Content-MD5` and faithfully reporting stored-object ETags; it is
not an independent remote SHA-256 scrub and cannot detect a backend returning
stale or dishonest ETags for corrupt bytes. Multipart or opaque ETags are rejected.

Use `--allow-same-cycle` only for an intentional same-cycle method replacement.
A winning build may never be mutated. Publish refuses builds older than six
hours and refuses older cycles.

## Serve an existing real local build

`sample-preview` never invents a sample. It requires a real manifest with 24
layer/frame artifact records covering 48 object paths, seeds those bytes plus a
pointer derived from the real manifest into local Wrangler R2, then runs
`wrangler dev --local` as a tracked child process. Assets are seeded only when
their build marker is absent; the local latest pointer is rewritten on every run
to the requested real build, so selecting build A after build B cannot leave B
current. The pointer is local-only and never published remotely. Pass `--reseed`
to overwrite the same immutable local keys intentionally.

The local preview passes `AV_LOCAL_DEVELOPMENT=true` only to local Wrangler.
For the standalone local Worker, run `pnpm --filter @av/api dev`; its explicit
local-only CLI override enables the same behavior without changing deployment vars.
This allows a missing `CF-Connecting-IP` to use the existing limiter with the
`localhost` key. Do not set this flag in staging or production; those fail closed
when the client IP or platform rate limiter is unavailable.

```sh
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 \
  pnpm sample-preview --manifest output/builds/gfs/{buildId}/manifest.json --port 8787
```

Then check the same read API used in production:

```sh
curl -s http://127.0.0.1:8787/healthz
curl -s 'http://127.0.0.1:8787/v1/models/gfs/latest?expand=manifest'
curl -s 'http://127.0.0.1:8787/v1/models/gfs/runs/{buildId}/sample?lat=32.9&lon=-117.25&frame=f003'
pnpm exec tsx scripts/smoke-api.ts --base-url http://127.0.0.1:8787 --model gfs
```

The local pointer is written only into `.wrangler/state`; it does not publish
to Cloudflare. A build whose `expiresAt` has passed is rejected rather than
served as current.

## What the data does and does not mean

- Source resolution is the native GFS 0.25 degree mesh, approximately 25 km at
  mid-latitudes. It is not true 250 m weather.
- Display zooms are `z0-z5` for GFS. Higher display zoom is interpolation and
  palette sampling, not finer science.
- HRRR and ICON-Armenia remain unavailable in the clients and API until regional
  coverage and publication are implemented. Their source adapters are not proof
  of a published regional product.
- `usable-lift-agl` subtracts the same model terrain used for the MSL value.
  It is not a high-resolution DEM correction.
- Method `dry-lenschow-pbl-1p2-v1` uses model surface pressure, 2 m temperature
  and humidity, sensible/latent flux, optional PBL closure, the dry parcel
  crossing and a 1.2 m/s usable-lift threshold. There is no cloud cap, no
  heat-flux-only depth fallback and no 1013.25 hPa pressure fallback.
- A resolved crossing above model PBL is kept. Missing PBL invalidates only the
  first-layer PBL closure branch.
- `valid`, `no-usable-lift`, `unavailable` and `outside-domain` are distinct.
  Physical no-lift exposes MSL `null` and AGL `0`; missing or outside data never
  becomes zero.
- Numeric output is a declared regular `EPSG:4326` grid at source-appropriate
  resolution. Bilinear estimates do not rerun the scientific solver at map
  pixels or sample points.
- Lift palette bins are the observed XC MSL colours; reusing them for AGL is an
  explicit product choice, not a verified XC AGL legend. Rain thresholds and
  colours remain provisional.

## Coverage

Policy `soaring-land-v1`: admitted land/coastal coverage within `55S-65N`,
with a 50 km seaward buffer, excluding `RUS`, `ATA` and `GRL`. Deserts and
inland lakes remain included. High-latitude Alaska/Canada and all of Russia are
deliberately excluded and must be shown as coverage limitations, not model
failure.

The mask uses cell-footprint intersection, not point-in-polygon at cell centres.
At GFS spacing, coast and exclusion borders can overreach or underfill by about
one cell diagonal. Halo bits are input-only and never make output active.
Coverage bitsets, tile bitsets, source release, checksum and regeneration recipe
live under `packages/contracts/coverage`.

## Scheduled operation

- `.github/workflows/ci.yml`: Node/pnpm pinned, frozen lockfile, lint,
  typecheck, test, build.
- `.github/workflows/forecast.yml`: once per day at `17 5 * * *` plus
  `workflow_dispatch`; per-model concurrency with `cancel-in-progress:false`;
  360-minute timeout; build, validate, then publish only when all four R2
  secrets exist. There is no retry step, so a failed run cannot resurrect an
  old build ID. A rerun builds a fresh ID.
- `.github/workflows/maintenance.yml`: manual serialized rollback or cleanup.
- `.github/workflows/deploy.yml`: manual read-only Worker deploy to staging or
  production, requiring credentials and explicit confirmation.

Required publication secrets, scoped to one bucket with Object Read & Write and
no account-wide administration:

```text
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET
```

If any secret is absent, the forecast job still builds and validates locally
and records that publication was skipped. It does not touch Cloudflare.

## One private bucket and Worker deployment

Create exactly one R2 bucket per environment. Keep it private: disable public
`r2.dev` and custom-domain bypass; there is no raw object proxy route. The
Worker binding is the only read path.

`apps/api/wrangler.jsonc` is the source of truth for binding and environments.
The checked-in configuration includes `staging` and `production` environments;
create or configure their private buckets before deployment. Each environment
uses one binding named `BUCKET`, one bucket, and no extra service:

```jsonc
{
  "name": "windy-av-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "windy-av-layer-staging" }],
  "rules": [{ "type": "Data", "globs": ["**/*.bin"], "fallthrough": true }],
  "env": {
    "staging": {
      "name": "windy-av-api-staging",
      "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "windy-av-layer-staging" }]
    },
    "production": {
      "name": "windy-av-api-production",
      "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "windy-av-layer" }]
    }
  }
}
```

Deploy read-only Worker environments manually:

```sh
export CLOUDFLARE_API_TOKEN=...
export CLOUDFLARE_ACCOUNT_ID=...
pnpm run deploy:staging
pnpm --filter @av/api exec wrangler tail --env staging
pnpm run deploy:production
pnpm --filter @av/api exec wrangler tail --env production
```

Or use `.github/workflows/deploy.yml` with repository secrets
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, and optional environment
variable `API_BASE_URL` for the post-deploy smoke test. The Worker has no write,
admin or job routes and needs no forecast-provider credentials.

Staging and production must be smoke-tested separately:

```sh
pnpm exec tsx scripts/smoke-api.ts --base-url https://{worker-host} --model gfs
```

## Stale data, freshness and manual fallback

Freshness is explicit, not inferred from a 200 response:

```sh
curl -s https://{worker-host}/v1/catalog
curl -s 'https://{worker-host}/v1/models/gfs/latest'
```

Check `ageSeconds`, `expiresAt` and per-model `available`. Worker caches never
extend `expiresAt`; expired builds return `404 not-retained`. GitHub schedules
may be delayed or disabled. The fallback is a manual `workflow_dispatch` with
an explicit cycle, or the same CLI on one cron runner. Do not add another
orchestration service.

## Rollback and cleanup

Rollback and cleanup are serialized mutations of the same pointer. They require
pausing every publisher first.

1. Disable `.github/workflows/forecast.yml` scheduling in Actions, or pause the
   external cron runner.
2. Cancel and wait for active publisher runs. Confirm no publisher holds a
   recent build ID.
3. Run the maintenance workflow with `confirm=publishers-paused`, or:

```sh
pnpm run rollback --model gfs --build-id {retainedBuildId} --publishers-paused
pnpm run cleanup --model gfs --publishers-paused
```

Rollback accepts only a currently retained, unexpired target. Cleanup deletes
only unreferenced build IDs older than 24 hours, rereads retained references,
and never deletes a rollback target. No bucket lifecycle rule may independently
delete referenced data. Resume scheduling explicitly after verification.

## Cost and performance measurement recipe

Measure, do not assume. For a real build record:

- source bytes fetched by product/field and acquisition time;
- decode, science, render, archive and upload times;
- active cells and expected tiles by zoom; halo overhead;
- peak RSS and disk usage; final PMTiles and sample-array bytes;
- Class A and Class B R2 operations, including multipart and any retries;
- Worker requests, CPU time, sampled R2 range reads, cache hit ratio;
- retention cost for archives, samples, manifests and masks;
- warm tile p95, warm one-frame sample p95, useful overlay time, and separate
  all-frame/cold budgets.

Use `.tools/pmtiles verify`, `smoke-build`, and local/preview timings first.
Repeat only on recorded representative NA/Armenia/NZ networks after regional
adapters exist. If targets fail, correct scope or cadence; do not add a service.
No free-tier, sub-15 GB or 83% CPU-savings claim is valid without measurements.
