# Forecast builder

Downloads GFS weather data and builds map tiles, point-forecast data, and a file
listing the contents of each build. The same app checks, uploads, rolls back,
and removes forecast builds.

After the [root setup](../../README.md), run from the repository root:

```sh
pnpm forecast --model gfs --out output --cache-dir .cache/gfs
pnpm test apps/batch
```

The forecast command needs internet access and can take a while. It reuses
previous downloads from `.cache/gfs` and prints the completed build's manifest
path. This data build is separate from `pnpm build`, which bundles the apps.
See [development](../../docs/development.md#build-a-real-gfs-forecast) to open a real build locally.

Useful files:

- [src/cli.ts](src/cli.ts): command entry point.
- [src/commands.ts](src/commands.ts): command names and options.
- [src/build.ts](src/build.ts): the forecast build steps.
- [src/noaa](src/noaa/README.md): GFS downloads and decoding.
- [src/render.ts](src/render.ts): map tile generation.

Calculations live in [forecast](../../packages/forecast/README.md).
See [operations](../../docs/operations.md) for uploads, deployment, and recovery.
