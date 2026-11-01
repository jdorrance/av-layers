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
[view.ts](src/view.ts) owns the panel. Shared client helpers live in
[`@av/contracts/client`](../../packages/contracts/README.md).

Built-module tests use a simulated host. Actual host installation and
behavior remain unverified; see [status](../../docs/status.md) and
[development](../../docs/development.md).

The v3 manifest owns layer labels, units, vertical/time support, palette/status semantics, coverage and attribution. Shared pure legend/series models and strict API validation live in the focused contracts client modules; Windy timestamp matching, cancellation, listener ownership and teardown stay in this host controller. Model options include only admitted production IDs.

Set `AV_API_BASE` explicitly for every hosted plugin build; a hosted asset using the localhost default cannot reach the deployed API. Hosting the built JavaScript proves asset availability only. Installation, host module resolution, map overlays, timestamp matching, point requests and close/reopen behavior must also pass on the actual Windy host.
