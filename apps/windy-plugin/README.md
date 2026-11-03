# Windy plugin

Renders forecast tiles and point time series inside Windy, syncing with Windy's
timeline and `singleclick` events.

Run tests or build `dist/plugin.min.js` from the repository root:

```sh
pnpm test apps/windy-plugin
AV_API_BASE=https://your-api.example pnpm --filter @av/windy-plugin build
```

`AV_API_BASE` is embedded at build time and defaults to `http://localhost:8787`.
[src/pluginConfig.ts](src/pluginConfig.ts) defines the plugin metadata emitted
to `dist/plugin.json`.

Load `plugin.min.js` over HTTPS in [Windy's developer loader](https://www.windy.com/developer-mode)
(see [Windy's debugging guide](https://docs.windy-plugins.com/getting-started/debugging.html),
or open the [staging loader](https://www.windy.com/dev/windy-av-preview-staging.pages.dev/windy-plugin/plugin.min.js)
in a fresh tab). For local UI work without Windy, use
[`@av/preview`](../preview/README.md).

## Source layout

- [src/plugin.ts](src/plugin.ts): Windy lifecycle hooks (`onopen`, `onclose`, `$destroy`).
- [src/controller.ts](src/controller.ts): build pinning, layer/frame selection, and host timestamp sync.
- [src/raster-layer.ts](src/raster-layer.ts): Leaflet tile layer adapter and abortable tile fetching.
- [src/view.ts](src/view.ts): plugin panel DOM and keyboard/gesture isolation.

See [the data guide](../../docs/data.md) for layer units and statuses.
