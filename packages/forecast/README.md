# @av/forecast

Pure column science and scalar reconstruction shared by batch rendering and
point sampling. Admitted model columns produce lift results; grid fields and
coordinates produce samples with status, support and interpolation metadata.

```ts
import { deriveColumn } from '@av/forecast';

const result = deriveColumn(column, activeLevelCount);
```

[Column types](src/science.ts) declare units and required inputs;
[sampling types](src/sampler.ts) describe fields, range plans and results.
The package owns calculation and reconstruction, with schemas and flags supplied
by [contracts](../contracts/README.md). Acquisition, storage and HTTP serving
remain with the applications.

[Method definitions](../contracts/src/methods.ts) declare the canonical adapter
inputs and the fixed numeric parameters consumed by the kernel. The batch bridge
converts normalized K/Pa inputs into the column API's °C/hPa using those same
constants. MSL and model-AGL share one lift method/evaluation; precipitation uses
a separate pure status check on normalized trailing-interval mm/h. Each build
stores its selected method definitions, inputs and caveats in `descriptors.methods`.

The active level count is required: callers may reuse a level array whose tail
contains stale entries. Only the active prefix contributes to validation or
physics. Batch sizes this scratch array from admitted pressure levels and
overwrites that prefix after below-ground screening. This removes level-object
churn; result objects and other science allocations still exist.

Sampling uses explicit regular-latitude/longitude or native Lambert-conformal
grid definitions, including the source Earth radius and authoritative coverage
bounds. Prepared samplers cache geometry, coverage and contributor indices under
a byte budget; fields remain caller-owned. Batch's direct pack writer consumes
the resulting `GridField` arrays, while this package owns cell encoding and the
shared block/range layout. Numeric sampling and tile reconstruction use the same
status, support, tie-break and interpolation rules.

[Science and sampling](../../docs/science.md) explains the method and edge rules.
[Data semantics](../../docs/data.md) explains the public results.
