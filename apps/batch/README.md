# Batch

`@av/batch` turns admitted upstream weather fields into immutable forecast
archives, a numeric block pack and a manifest. Its CLI also validates, publishes,
rolls back and cleans up builds. GFS is the integrated build path; regional
products are deferred in the [roadmap](../../docs/roadmap.md).

Run from the repository root after [setup](../../docs/getting-started.md):

```sh
pnpm run build:sample --model gfs --out output --cache-dir .cache/gfs
```

The command prints the completed manifest path. [src/cli.ts](src/cli.ts) owns
commands and options; [src/build.ts](src/build.ts) owns build orchestration.
Acquisition adapters own source admission, while
[forecast](../../packages/forecast/README.md) owns shared science and sampling.

Follow [getting started](../../docs/getting-started.md) to validate and inspect a
build, [operations](../../docs/operations.md) to publish or recover one, and
[development](../../docs/development.md) to extend or verify the pipeline.
