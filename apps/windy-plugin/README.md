# Windy plugin

Draws usable-lift tiles on Windy's map, following its timeline and staying under the wind particles.

```sh
pnpm --filter @av/windy-plugin build
pnpm --filter @av/windy-plugin serve
```

`AV_API_BASE` is embedded at build time and defaults to `http://localhost:8787`. Open `https://127.0.0.1:9999/plugin.js`, accept the certificate, then load that URL from [Windy's developer loader](https://www.windy.com/developer-mode).

Click the map for a diurnal lift chart and point summary. Chart hours follow the
host timeline; units switch between metres/m/s and feet/knots. Closing the pane
ends point requests and leaves the overlay until build expiry. For a map without
Windy, use [`@av/preview`](../preview/README.md).

## Source layout

- [src/plugin.ts](src/plugin.ts): pane lifecycle. The forecast layer outlives the pane.
- [src/controller.ts](src/controller.ts): build pinning, usable-lift selection, and host timestamp sync.
- [src/raster-layer.ts](src/raster-layer.ts): LeafletGL tile layer, tile protocol, and stacking order.
- [src/view.ts](src/view.ts): model and opacity controls.

See [the data guide](../../docs/data.md) for layer units.
