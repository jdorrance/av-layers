# @av/forecast

Pure column science and scalar reconstruction shared by batch rendering and
point sampling. Admitted model columns produce lift results; grid fields and
coordinates produce samples with status, support and interpolation metadata.

```ts
import { deriveColumn } from '@av/forecast';

const result = deriveColumn(column);
```

[Column types](src/science.ts) declare units and required inputs;
[sampling types](src/sampler.ts) describe fields, range plans and results.
The package owns calculation and reconstruction, with schemas and flags supplied
by [contracts](../contracts/README.md). Acquisition, storage and HTTP serving
remain with the applications.

[Science and sampling](../../docs/science.md) explains the method and edge rules.
[Data semantics](../../docs/data.md) explains the public results.
