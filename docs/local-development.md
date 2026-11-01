# Local development without model downloads

Run these commands from the repository root. Install the pinned pnpm version
from `package.json`; `pnpm install` selects the project-local Node runtime without
changing your host Node. Initial dependency and PMTiles installation needs network
access. The fixture itself requires no NOAA data or Cloudflare account.

```sh
pnpm install --frozen-lockfile
pnpm tools:pmtiles
pnpm dev:fixture
```

The last command builds and validates 40 synthetic native-grid cells, two hourly
frames, all three existing scalar layers, a numeric pack, content-addressed
coverage, provenance and zoom 0–2 PMTiles archives. It seeds local R2 and starts
the actual Worker at `http://127.0.0.1:8787`. The fields are deterministic; cycle,
build identity and expiration are created for the current run. The first-frame
precipitation value at latitude **40**, longitude **−100** is **2.75 mm/h**.

These are generated test values, not a GFS forecast. The local catalog labels
them **SYNTHETIC offline fixture**. The fixture uses the `gfs` URL namespace only
to exercise existing consumers; its recipe, configuration, domain, coverage and
attribution identify synthetic data. A separate
[`fixture-worker.ts`](../apps/api/test/fixture-worker.ts) admits that recipe.
The production Worker entry point and product registry do not import it.

In another terminal, start the map with a neutral, disconnected basemap:

```sh
VITE_API_BASE=http://127.0.0.1:8787 VITE_OFFLINE_FIXTURE=true pnpm --filter @av/preview dev --host 127.0.0.1
```

Open Vite's URL. The panel identifies the data as synthetic. Change frame/layer, click
inside the North American rectangle, and sample the selected point. Outside that
rectangle the API returns `outside-domain`. `/docs` and `/openapi.json` on the
local API describe the same running contract. Stop each terminal with Ctrl-C.

## Repeat, inspect and reset

The defaults isolate generated files in `output/offline-fixture` and local R2
in `.wrangler/fixture-state`. Each `pnpm dev:fixture` run generates a fresh build
and selects it. There are no remote uploads. To generate or seed without leaving
a server running:

```sh
pnpm dev:fixture --generate-only
pnpm dev:fixture --seed-only
```

To reopen the exact printed manifest, replace `BUILD_ID`:

```sh
pnpm sample-preview --fixture --manifest output/offline-fixture/builds/gfs/BUILD_ID/manifest.json
```

Use `--port 8788`, `--out output/my-fixture` on `dev:fixture`, or
`--persist-to .wrangler/my-fixture-state` for an isolated session. The preview
checks hashes before seeding, uploads dependencies before the manifest and
publishes the latest pointer last. One local Wrangler proxy session handles all
objects; it always closes before the serving Worker starts. Reopening checks
stored sizes and hashes, reuses intact immutable objects, repairs missing ones
even when a completion marker exists, and rewrites the latest pointer. `--reseed`
rewrites every local copy. An interrupted seed can be rerun normally.

One controlled local measurement on 2026-11-01 used the same 14 fixture objects
(20,741 bytes) and two empty isolated stores on macOS arm64, Node 22.23.4.
Single-session seeding took 852 ms including cold SDK import and hash validation;
14 serial Wrangler CLI uploads took 7,800 ms. This small-fixture observation
motivates the single-session path; it is not a full-build throughput claim.
The receipt is retained locally at `output/evidence/foundation/local-seeding.json`.

After stopping the local processes, remove only the fixture state to start over:

```sh
rm -rf output/offline-fixture .wrangler/fixture-state
```

## Verification and live data

The focused tests build real synthetic artifacts, verify both regular and Lambert
native grids, exercise interrupted/repeated seeding, and reopen persisted local
workerd state after teardown:

```sh
pnpm exec vitest run scripts/sample-preview.test.ts apps/batch/src/native-build.integration.test.ts
```

The broader checks are listed in the [root README](../README.md#development-checks).
Use [getting started](getting-started.md) for a real GFS acquisition and
[operations](operations.md) for deployed publication. Never publish this fixture;
the production validator rejects its synthetic recipe.
