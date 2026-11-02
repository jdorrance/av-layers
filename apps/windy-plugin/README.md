# Windy plugin

`@av/windy-plugin` is one consumer of the forecast API, displaying forecast
tiles and point series inside Windy using the host map and timestamp store.

Build from the repository root with the intended API address:

```sh
AV_API_BASE=https://your-api.example pnpm --filter @av/windy-plugin build
```

`AV_API_BASE` is embedded at build time and defaults to `http://localhost:8787`.
Rollup writes `dist/plugin.js` and `dist/plugin.min.js` using the pinned Windy
devtools. Host `@windy/*` modules remain external.

[plugin.ts](src/plugin.ts) owns host lifecycle and requests;
[controller.ts](src/controller.ts) owns build/frame state and overlay teardown;
[raster-layer.ts](src/raster-layer.ts) adapts the current Windy raster API;
[view.ts](src/view.ts) owns the accessible panel. Shared client helpers live in
[`@av/contracts/client`](../../packages/contracts/README.md).

Built-module tests use a simulated host. Current actual-host qualification
evidence and remaining gates are recorded in [status](../../docs/status.md);
see [development](../../docs/development.md) for the host test workflow.

Windy 51 uses LeafletGL, whose raster layer does not emit classic Leaflet
`tileloadstart`, `tileerror`, `tileload`, or `tileunload` events. The adapter
uses the public [TileLayer.source() API](https://windycom.github.io/LeafletGL/docs/API/LeafletGL/classes/TileLayer/)
and bridges source `dataloading`, `error`, `data`, and `dataabort` events by
tile object identity. This reports both network failures and image decoding
failures, keeps an error visible while its failed tile remains, and removes
the exact subscriptions on close. Successful tiles are tracked weakly so
the plugin cannot retain tiles evicted from the host's cache.

Each layer/frame generation registers its own public
[custom raster protocol](https://windycom.github.io/LeafletGL/docs/API/MapLibre/functions/addProtocol/).
The [shared tile transport](../../packages/contracts/src/client-raster.ts)
admits two simultaneous requests, bounds waiting requests and bytes, applies
a total deadline, and retries only transient failures a finite number of times.
It accepts only tile paths on the configured API. A frame/layer replacement
or close cancels queued and active work and unregisters that generation's
protocol. Other Windy layers and global host request settings are untouched.

The v3 manifest owns layer labels, units, vertical/time support, palette/status semantics, coverage and attribution. Shared pure legend/series models and strict API validation live in the focused contracts client modules; Windy timestamp matching, cancellation, listener ownership and teardown stay in this host controller. Model options include only admitted production IDs.

Set `AV_API_BASE` explicitly for every hosted plugin build; a hosted asset using the localhost default cannot reach the deployed API. Hosting the built JavaScript proves asset availability only. Installation, host module resolution, map overlays, timestamp matching, point requests and close/reopen behavior must also pass on the actual Windy host.
