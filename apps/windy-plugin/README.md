# Windy plugin

Displays forecast tiles and point forecasts inside Windy. The plugin follows
Windy's selected time and uses the same API as the standalone preview.

After the [root setup](../../README.md), run from the repository root:

```sh
pnpm test apps/windy-plugin
AV_API_BASE=https://your-api.example pnpm --filter @av/windy-plugin build
```

The build writes `dist/plugin.js` and `dist/plugin.min.js`. Set `AV_API_BASE` to
the API you want to use; it is included in the bundle and defaults to
`http://localhost:8787`.

Serve the bundle over HTTPS and open it with
[Windy's developer loader](https://www.windy.com/developer-mode).
See [Windy's plugin guide](https://docs.windy-plugins.com/getting-started/debugging.html)
for the loader's setup requirements. For everyday UI work without a Windy login,
use the [standalone preview](../preview/README.md).

Useful files:

- [src/plugin.ts](src/plugin.ts): connects the plugin to Windy.
- [src/controller.ts](src/controller.ts): selected build, layer, and time.
- [src/raster-layer.ts](src/raster-layer.ts): Windy tile loading and cleanup.
- [src/view.ts](src/view.ts): panel and controls.

This is an experimental plugin. See [the data guide](../../docs/data.md) for what
the forecasts mean.
