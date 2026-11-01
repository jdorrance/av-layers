# Development

Use [offline development](local-development.md) for a tiny deterministic fixture
and [getting started](getting-started.md) for real GFS acquisition.
Use [extension recipes](extensions.md) before admitting another provider, quantity or grid.
The [workspace map](architecture.md#workspace-map) links each package's purpose
and entry points; read those boundaries before changing implementation details.

## Making a change

Keep a change within the responsibility that owns it. Provider handling belongs
in batch, scientific behavior in forecast, shared data definitions and client
helpers in contracts, and UI specifics in each consumer client. Extract a helper
when it gives an existing caller less to understand. Preserve value, absence and
freshness semantics during structural changes.

Add a focused regression test for a behavioral fix, then run the
[development checks](../README.md#development-checks). Those commands define
the CI baseline. For artifact or serving changes, follow
the validation or smoke-test steps in [getting started](getting-started.md)
and [operations](operations.md).

## What the checks establish

Forecast tests exercise calculations, missing data and interpolation. Batch
tests cover source admission, rendering, artifact validation and publication
races. API tests exercise routes, storage reads, coverage and caching. Client
tests cover API handling, frame selection, expiry and a built plugin module
loaded against a simulated host.

Real-build validation and local API smoke tests exercise the assembled pipeline.
They complement fixtures; neither a simulated host nor local storage establishes
deployed Cloudflare or live consumer host behavior. Keep new evidence and its
limits in [status](status.md).

To investigate GFS acquisition without rendering a forecast, run
`pnpm input:proof --cache-dir .cache/gfs`. It prints an input-admission receipt;
an optional `--cycle` selects an upstream run. The
[proof entry point](../apps/batch/src/noaa/prove.ts) owns the diagnostic scope.

For performance and capacity changes, run `pnpm capacity` and keep exact-value
and pixel comparisons alongside timing evidence.

## Documentation ownership

The root README owns orientation, the document index and development checks.
[Getting started](getting-started.md) owns setup; [architecture](architecture.md)
owns component boundaries; [data](data.md) owns interpretation;
[science](science.md) owns the method; [operations](operations.md) owns running
and publishing the service. [Status](status.md) records demonstrated behavior,
and [roadmap](roadmap.md) tracks remaining work.

Package READMEs provide a short usage example and links to the next layer.
Update the owner when behavior changes; link to it elsewhere.
Keep signatures and endpoint details with their executable definitions. The [generated reference](reference.md) and OpenAPI snapshot come from those definitions. After changing them, run `pnpm exec node --import tsx scripts/generate-reference.ts`; `pnpm docs:check` rejects stale output.

## Verification

`pnpm verify` is the single offline verification entry point used locally and
in CI. It runs lint, type checking, fixture tests, the real local workerd test,
documentation freshness/link checks and production bundles once each. Install
the pinned PMTiles tool during setup before disconnecting from the network.
Live acquisition, full-build qualification and deployed load/host checks remain
separate, explicit operations. Superseded feature-branch and pull-request
verification is cancelled; deployment, publication and maintenance remain
serialized without cancellation.

## Evidence and cleanup

Run `pnpm docs:check` for repository Markdown file targets and
`pnpm test:runtime` for actual workerd overlap/cancellation behavior. Browser
receipts distinguish simulated host, desktop/mobile-layout and actual host/device
checks. The [serving budget](serving-budgets.md) defines measured cache states,
body-consumption latency and memory limitations.

Generated forecasts, caches, emulator state and raw measurements stay under
ignored output directories. Commit compact reproducible receipts and experiment
scripts, never downloaded weather archives or credentials. Delete a failed local
fixture's own persistence directory only after its Worker has stopped. Production
cleanup uses the serialized maintenance workflow; local file cleanup grants no
authority to delete R2 objects.
