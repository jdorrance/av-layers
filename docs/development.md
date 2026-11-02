# Development

Run commands from the repository root. The project is in alpha and currently
supports GFS only. See [the project layout](architecture.md#workspace-map) to find
the code for each app and package.

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

## Build a real GFS forecast

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs
```

This downloads a complete GFS run and can take a while. Repeated builds reuse
`.cache/gfs`. To choose a run, add `--cycle` with an available GFS 00, 06, 12, or
18 UTC timestamp. Without it, the builder finds a complete recent run.

Copy the printed manifest path into the following command, replacing `BUILD_ID`:

```sh
pnpm sample-preview --manifest output/builds/gfs/BUILD_ID/manifest.json
```

This validates the build, copies it into local storage, and starts the API and map.
It reuses intact local files and repairs missing ones. The real-data basemap
needs internet access. Ctrl-C stops both servers. Read [the data guide](data.md)
for units, coverage, and forecast times, and [science](science.md) for calculations.

## Tests and builds

`pnpm test` runs the tests without downloading weather data. Add a path to focus
on one area, such as `pnpm test packages/forecast` or `pnpm test apps/api`.
The suite includes a disposable local Worker test; it does not use remote R2.

Run `pnpm verify` before submitting a change. It runs lint, type checks, tests,
documentation checks, and app builds. `pnpm build` just bundles the apps; it does
not publish forecasts or deploy services. Use [operations](operations.md) for that.

After changing API schemas or CLI definitions, refresh the generated reference:

```sh
pnpm exec node --import tsx scripts/generate-reference.ts
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
