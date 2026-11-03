# Development

Run commands from the repository root. The alpha builder supports GFS and
ICON-EU. Scheduled forecasts select both models; manual runs can select either
model or both. See [status](status.md) for release evidence and
[the project layout](architecture.md#workspace-map) for code ownership.

## Setup

Use the pnpm version declared in [package.json](../package.json):

```sh
pnpm install
pnpm tools:pmtiles
```

pnpm installs the project's Node runtime locally. The second command installs
the PMTiles tool in `.tools/`. These initial downloads need internet access;
local development does not need a Cloudflare account.

## Start the sample-data map

```sh
pnpm dev
```

This generates a small test forecast and starts both the local API and map.
Open the URL printed by Vite. Ctrl-C stops both servers. The API normally runs
at `http://127.0.0.1:8787`; its `/docs` page describes the available requests.

The map labels its data **SYNTHETIC offline fixture** and uses a plain background
with no external map requests. These are test values, not a weather forecast.
Select the first frame and sample latitude **40**, longitude **−100**: rain is
**2.75 mm/h**. Points outside the test rectangle return `outside-domain`.

Each run creates fresh test data under `output/offline-fixture` and stores local
API data under `.wrangler/fixture-state`. Nothing is uploaded. Use
`pnpm dev --generate-only` to write files without starting servers, or
`pnpm dev --seed-only` to also copy them into local storage.

## Build a real forecast

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs
```

This downloads the fields for the configured GFS horizon and can take a while.
Repeated builds reuse `.cache/gfs`. For regional ICON-EU lift, first inspect the
resource estimate, optionally prove one input frame, then build:

```sh
pnpm capacity --model icon-eu
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
pnpm forecast --model icon-eu --out output --cache-dir .cache/icon-eu
```

Capacity is offline; the proof and forecast commands download weather data.
The ICON-EU proof checks one frame's acquisition and normalized inputs; it does
not build all forecast hours or prove forecast skill. Both models accept `--cycle`
with an available 00, 06, 12, or 18 UTC initialization. Without it, the adapter
discovers a recent admissible run. The [CLI reference](reference.md#batch-cli) owns the
supported options.

The build records its commit and any uncommitted producer or runtime-config
changes. Commit those changes before publishing.

Copy the printed manifest path into the following command, replacing `MODEL`
and `BUILD_ID`:

```sh
pnpm sample-preview --manifest output/builds/MODEL/BUILD_ID/manifest.json
```

This validates the build, copies it into local storage, and starts the API and map.
It reuses intact local files and repairs missing ones. The real-data basemap
needs internet access. Ctrl-C stops both servers. Read [the data guide](data.md)
for units, coverage, and forecast times, and [science](science.md) for calculations.

## Tests and builds

`pnpm test` runs the tests without downloading weather data. Add a path to focus
on one area, such as `pnpm test packages/forecast` or `pnpm test apps/api`.
The suite includes a disposable local Worker test; it does not use remote R2.
ICON's portable decoder and acquisition fixtures run without sibling repositories.
Its [optional retained-data check](../apps/batch/src/icon/README.md#offline-checks)
uses `ICON_DWD_PROBE_DIR` to locate six historical DWD fields and their manifest;
it never searches local sibling directories implicitly.

Shared dependency versions live in the catalog in `pnpm-workspace.yaml`.
After changing them, run `pnpm install` and commit the updated lockfile.

Run `pnpm verify` before submitting a change. It runs lint, type checks, tests,
documentation checks, and app builds. `pnpm build` just bundles the apps; it does
not publish forecasts or deploy services. Use [operations](operations.md) for that.

After changing API schemas or CLI definitions, refresh the generated reference:

```sh
pnpm docs:generate
pnpm docs:check
```

Add a focused test for a behavior change. Keep source handling in batch,
calculations in forecast, shared definitions in contracts, and UI behavior in
the relevant app. Read [the extension guide](extensions.md) before adding a field,
provider, or grid. Performance changes should preserve numeric values and pixels;
`pnpm capacity` shows estimated build resources before downloading data.

## Troubleshooting

- **Missing PMTiles:** rerun `pnpm tools:pmtiles`. Use project pnpm commands so
  they select the installed Node runtime.
- **API port in use:** use `pnpm dev --port 8788` or pass `--port 8788` to
  `pnpm sample-preview`. The map is connected to that port automatically.
- **Expired local build:** rerun `pnpm dev`, or build a new real forecast.
  Changing the expiry in an old file does not repair a build.
- **Broken local test state:** stop the servers, then remove only
  `output/offline-fixture` and `.wrangler/fixture-state` before running `pnpm dev`.
- **Missing coverage assets:** they are normally checked in. If regeneration is
  needed, install `uv` and run `pnpm masks:build`; this downloads the source shapes.

Keep generated forecasts, caches, local server state, and experiment output in
ignored directories. Do not commit downloaded weather archives or credentials.
Local tests do not replace checking the deployed API or actual Windy host.
