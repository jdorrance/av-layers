# Getting started

For fast application work, start with [offline development](local-development.md).
This guide builds a real GFS forecast, then inspects it through the local API and map preview.
Run these commands from the repository root. Acquisition needs internet access;
local preview needs no Cloudflare account. See [status](status.md) for the latest
validated build and remaining release work.

## Set up

Use the pnpm version declared in [package.json](../package.json):

```sh
pnpm install --frozen-lockfile
pnpm tools:pmtiles
.tools/pmtiles version
```

`pnpm install` downloads the project-local Node runtime declared in
`devEngines.runtime` and locked with its checksum in `pnpm-lock.yaml`. Project
scripts use it automatically, so `pnpm test` works even when the terminal's
`node` is an older version. The host Node installation is not changed. Node 22
is required for the real `node:sqlite` rendering and integration tests.

The [PMTiles installer](../scripts/setup-pmtiles.mjs) owns platform support,
version pins and release checksums. It installs the verified binary in `.tools/`.
Coverage assets are included under `packages/contracts/coverage`.

<details>
<summary>Using the pinned toolchain without changing your host Node</summary>

```sh
npx --yes --package=node@22.23.4 --package=pnpm@10.34.9 pnpm install --frozen-lockfile
```

This also bootstraps the declared pnpm version if necessary. After installation,
ordinary `pnpm` project commands select the pinned local runtime automatically.

</details>

## Build a forecast

```sh
pnpm run build:sample --model gfs --out output --cache-dir .cache/gfs
```

The command discovers an admissible upstream cycle, builds its forecast and
prints the manifest path. To select a cycle explicitly, add `--cycle` with a GFS
00, 06, 12 or 18 UTC timestamp, such as `2026-10-30T00:00:00.000Z`, while that
cycle remains available upstream. This is a substantial real-data build; its download
cache stays local.

Set `AV_MANIFEST` to the printed path, replacing `BUILD_ID` below:

```sh
AV_MANIFEST=output/builds/gfs/BUILD_ID/manifest.json
pnpm exec tsx apps/batch/src/cli.ts validate --manifest "$AV_MANIFEST"
pnpm exec tsx scripts/smoke-build.ts --manifest "$AV_MANIFEST"
```

The manifest identifies the immutable archives and numeric block pack. Their
meaning, coverage and limits are described in [data](data.md); scientific
assumptions are in [science](science.md).

## Open the local preview

In the same terminal:

```sh
pnpm sample-preview --manifest "$AV_MANIFEST" --port 8787
```

This seeds the real build into local Wrangler R2 and starts the Worker. It
rewrites the local latest pointer on each run, reuses already-seeded assets,
and stores state under `.wrangler/state`. Use `--persist-to` for isolated state;
`--reseed` deliberately replaces the local copies. Expired builds must be rebuilt.

In a second terminal, from the repository root:

```sh
VITE_API_BASE=http://127.0.0.1:8787 pnpm --filter @av/preview dev --host 127.0.0.1
```

Open the URL Vite prints. Select a layer and frame, click the map to choose a
point, then click **Sample clicked point**. The basemap also needs internet access.

The API's [interactive documentation](http://127.0.0.1:8787/docs) and
[OpenAPI document](http://127.0.0.1:8787/openapi.json) describe its live contract.
Check the populated API with:

```sh
pnpm exec tsx scripts/smoke-api.ts --base-url http://127.0.0.1:8787 --model gfs
```

For code changes, use the [root development checks](../README.md#development-checks).
[Operations](operations.md) covers remote publication and deployment.

<details>
<summary>Missing or intentionally regenerated coverage assets</summary>

Older or incomplete checkouts may lack the generated bundle. Before building,
install `uv` and run `pnpm masks:build` once. The
[generator](../scripts/masks/build_masks.py) downloads the pinned Natural Earth
source and checks the required native GIS libraries. This is a preparation step,
not part of scheduled forecasts. See [development](development.md) before changing
coverage; each build publishes its immutable descriptor and bitsets; the Worker resolves and verifies that exact content identity.

</details>
