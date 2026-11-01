# @av/contracts

Shared producer/consumer vocabulary: schemas, admitted product definitions, regular latitude/longitude and Lambert conformal grid geometry, immutable coverage descriptors, palettes and sample flags. The alpha wire contract is version 3; old manifests are rejected.

`manifestSchema.parse(raw)` checks structure. `validateArtifactRecords(manifest)` checks frame/layer identity, time support, descriptor references, artifact paths and sample-pack dimensions. Batch publication also verifies artifact bytes, hashes and provenance. A manifest records recipe/configuration/domain identity and source revision, immutable display/science descriptors (including required normalized inputs, method parameters and caveats), content-addressed coverage and a required provenance sidecar. Do not recover these meanings from the current GFS constants when reading an older retained build.

[Public exports](src/index.ts) own signatures/constants. [geometry.ts](src/geometry.ts) owns geographic/native-grid transforms; [coverage.ts](src/coverage.ts) owns the hash-addressed descriptor schema. [json.ts](src/json.ts) defines the shared byte and JSON-structure limits checked by publication and serving. [methods.ts](src/methods.ts) declares the two current scalar method definitions; the numerical kernel consumes those exact constants, while clients read retained snapshots. The generated [GFS lookup witness](coverage/manifest.json) is a producer input, not a mandatory Worker bundle asset. Production product admission currently includes GFS alone. The explicit `@av/contracts/fixture-product` import is for local development/tests and is not in the production registry.

[methods.ts](src/methods.ts) declares the current normalized input fields, shared lift/precipitation dependencies and immutable kernel parameters. Builds store the selected definitions in `descriptors.methods`. Wire validation checks bounded types and internal input/output references; retained snapshots do not need to match today's constants, units or executable methods.

`@av/contracts/client` is the shared consumer entrypoint:

- [client-api.ts](src/client-api.ts): pinned metadata/sample validation, a 10-second total request deadline, bounded 1 MiB JSON responses and at most one jittered retry for network/502/503/504 failures. Caller cancellation, invalid JSON/schema and 404 responses are not retried.
- [client-types.ts](src/client-types.ts): consumer data shapes.
- [client-time.ts](src/client-time.ts): frame matching, retention expiry and independent forecast-horizon warnings.
- [client-view.ts](src/client-view.ts): pure legend/series/diagnostic models, descriptor-driven attribution and tile options.

Sample responses must exactly match the requested frame/layer set, coordinates, times, pinned build/method/source/coverage/expiry and layer-specific value/status/support rules. Result counts come from manifest capabilities. Preview and Windy share those rules while retaining separate map and lifecycle controllers.

[Data semantics](../../docs/data.md), [architecture](../../docs/architecture.md) and [serving budgets](../../docs/serving-budgets.md) explain operational behavior and limits.
