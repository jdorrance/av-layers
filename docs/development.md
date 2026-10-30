# Development

Use [getting started](getting-started.md) for toolchain and local API setup.
The [workspace map](architecture.md#workspace-map) links each package's purpose
and entry points; read those boundaries before changing implementation details.

## Making a change

Keep a change within the responsibility that owns it. Provider handling belongs
in batch, scientific behavior in forecast, shared data definitions in contracts,
and presentation in the clients. Extract a helper when it gives an existing
caller less to understand. Preserve value, absence and freshness semantics
during structural changes.

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
deployed Cloudflare or actual Windy behavior. Keep new evidence and its limits in
[status](status.md).

To investigate GFS acquisition without rendering a forecast, run
`pnpm input:proof --cache-dir .cache/gfs`. It prints an input-admission receipt;
an optional `--cycle` selects an upstream run. The
[proof entry point](../apps/batch/src/noaa/prove.ts) owns the diagnostic scope.

## Documentation ownership

The root README owns orientation, the document index and development checks.
[Getting started](getting-started.md) owns setup; [architecture](architecture.md)
owns component boundaries; [data](data.md) owns interpretation;
[science](science.md) owns the method; [operations](operations.md) owns running
and publishing the service. [Status](status.md) records demonstrated behavior,
and [roadmap](roadmap.md) tracks remaining work.

Package READMEs provide a short usage example and links to the next layer.
Update the owner when behavior changes; link to it elsewhere.
Keep signatures and endpoint details with their executable definitions.
