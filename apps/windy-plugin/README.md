# Windy plugin

Draws usable-lift tiles on Windy's map, following its timeline and staying under the wind particles.

```sh
pnpm --filter @av/windy-plugin build
pnpm --filter @av/windy-plugin serve
```

`AV_API_BASE` is embedded at build time and defaults to `http://localhost:8787`. Open `https://127.0.0.1:9999/plugin.js`, accept the certificate, then load that URL from [Windy's developer loader](https://www.windy.com/developer-mode).

Click the map for the selected hour’s sampled AGL and MSL lift. The native
sounding and later hours fill in as pages arrive. The chart uses MSL and labels
native thermal tops and model ground separately. Later point times retain the
map frame and show both UTC times. The scalar chart covers builds that publish
no native profiles.
Closing the pane ends point requests and leaves the overlay until build expiry.
For a standalone map, use [`@av/preview`](../preview/README.md).

## Source layout

- [src/plugin.ts](src/plugin.ts): pane lifecycle and Windy map events.
- [src/controller.ts](src/controller.ts): build pinning, usable-lift selection, and host timestamp sync.
- [src/raster-layer.ts](src/raster-layer.ts): LeafletGL tile layer, tile protocol, and stacking order.
- [src/view.ts](src/view.ts): model and opacity controls and the point panel,
  using [`@av/client`](../../packages/client/README.md) for point requests.

See [the data guide](../../docs/data.md) for layer units.
