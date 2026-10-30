# @av/contracts

Shared vocabulary for producers and consumers: schemas, layer and model IDs,
grid geometry, coverage lookups, palettes and sample flags. It accepts untrusted
metadata at schema boundaries and exposes parsed values and inferred types.

```ts
import { manifestSchema } from '@av/contracts';

const manifest = manifestSchema.parse(JSON.parse(manifestText));
```

Parsing checks structure; batch validation additionally checks artifact bytes
and publication consistency. The [public exports and types](src/index.ts) own
signatures and constants, [client helpers](src/client.ts) (`@av/contracts/client`)
own shared API, time, tile and presentation logic for any consumer, and the
[coverage manifest](coverage/manifest.json) owns generated lookup metadata.

[Data semantics](../../docs/data.md) explains values, absence and freshness.
[Architecture](../../docs/architecture.md) shows how the packages fit together.
