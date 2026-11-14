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
The pane shows the displayed frame's UTC time. The overlay hides when Windy's
selected time falls outside the map forecast. Closing the pane ends point
requests while the overlay continues following Windy's timeline until build expiry.
Choose **Auto** to use the finest available forecast that covers the map center
and Windy's selected time.
For a standalone map, use [`@av/preview`](../preview/README.md).

The [build check](vite.config.ts) bounds compressed plugin JavaScript and
rejects server modules in the browser output. The current build measures
98,172 bytes gzip against a 98,250-byte limit; the embedded build timestamp
moves the result by a few bytes between builds.

## Source layout

- [src/plugin.ts](src/plugin.ts): pane lifecycle and Windy map events.
- [src/controller.ts](src/controller.ts): build pinning, usable-lift selection, and host timestamp sync.
- [src/raster-layer.ts](src/raster-layer.ts): LeafletGL tile layer, tile protocol, and stacking order.
- [src/view.ts](src/view.ts): model and opacity controls and the point panel,
  using [`@av/client`](../../packages/client/README.md) for point requests.

See [the data guide](../../docs/data.md) for layer units.
