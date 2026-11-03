# Development

Run commands from the repository root. See [status](status.md) for release
evidence and [architecture](architecture.md#workspace-map) for package layout.

## Setup

Use the pnpm version in [package.json](../package.json):

```sh
pnpm install
pnpm tools:pmtiles
```

pnpm installs the pinned Node runtime locally, and `tools:pmtiles` downloads the
PMTiles CLI binary into `.tools/`.

## Start the sample-data map

```sh
pnpm dev
```

Generates a small synthetic forecast under `output/offline-fixture`, seeds local
R2 state in `.wrangler/fixture-state`, and starts the local API (`http://127.0.0.1:8787`)
and MapLibre preview. Open `/docs` on the API port for interactive OpenAPI docs.
On the first frame at latitude `40`, longitude `-100`, `precip-rate` is
`2.75 mm/h`.

Use `pnpm dev --generate-only` to write fixture files without starting servers,
or `pnpm dev --seed-only` to seed `.wrangler/fixture-state` and exit.

## Build a real forecast

Save the completed terrain import's reference as `output/terrain-catalog-ref.json`
and configure [R2 access](../apps/batch/src/terrain/README.md#import-a-dataset).
The catalog supplies configured refinement zones; models with no intersecting
zones can omit the catalog option.

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs \
  --terrain-catalog-ref output/terrain-catalog-ref.json
```

For ICON-EU:

```sh
pnpm capacity --model icon-eu
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
pnpm forecast --model icon-eu --out output --cache-dir .cache/icon-eu \
  --terrain-catalog-ref output/terrain-catalog-ref.json
```

`capacity` prints offline memory, tile, and sample-pack estimates. `input:proof`
downloads and validates one frame. Both models accept `--cycle YYYY-MM-DDTHH:00:00Z`
(`00`, `06`, `12`, or `18` UTC) or discover the latest complete upstream run
automatically. See the [CLI reference](reference.md#batch-cli) for all flags.

To view a completed build locally:

```sh
pnpm sample-preview --manifest output/builds/MODEL/BUILD_ID/manifest.json
```

This validates the build, seeds local Wrangler storage, and starts the API and
preview server.

## Tests and builds

```sh
pnpm test
pnpm verify
```

`pnpm test` runs the offline test suite (pass a path such as
`pnpm test packages/forecast` to run a subset). To run the optional retained DWD
probe check for ICON-EU, set `ICON_DWD_PROBE_DIR` as shown in the
[ICON adapter guide](../apps/batch/src/icon/README.md#offline-checks).

`pnpm verify` runs lint, typecheck, tests, `docs:check`, and app builds. After
changing API schemas, product configs, or CLI flags, regenerate the reference docs:

```sh
pnpm docs:generate
pnpm docs:check
```

## Troubleshooting

- **Missing PMTiles binary:** run `pnpm tools:pmtiles`.
- **Port in use:** pass `--port 8788` to `pnpm dev` or `pnpm sample-preview`.
- **Expired local build:** rerun `pnpm dev` or `pnpm forecast`.
- **Corrupt local state:** stop the servers and remove `output/offline-fixture`
  and `.wrangler/fixture-state`.
- **Regenerate coverage masks:** install `uv` and run `pnpm masks:build`.
