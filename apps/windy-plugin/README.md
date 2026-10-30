# Windy plugin

`@av/windy-plugin` displays API forecast tiles and point series inside Windy,
using the host map and timestamp store.

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
[preview](../preview/README.md).

Built-module tests use a simulated host. Actual Windy-host installation and
behavior remain unverified; see [status](../../docs/status.md) and
[development](../../docs/development.md).
