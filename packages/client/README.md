# `@av/client`

Fetch pinned forecasts and manage tile and point requests for browser clients.

```ts
import { ApiClient } from '@av/client';

const api = new ApiClient({ baseUrl: 'http://localhost:8787' });
const build = await api.latest('gfs');
const point = api.pointSeries(build, { lat: 40, lon: -100 });
const series = await point.load('day');
point.dispose();
```

[`@av/contracts`](../contracts/README.md) owns the wire schemas and model
descriptors. [`@av/windgram`](../windgram/README.md) owns point presentation.

## Entry points

- [`@av/client`](src/index.ts) provides the API client, raster transport, frame
  matching, tile URLs, and sample formatting.
- [`@av/client/dom`](src/dom.ts) renders legends and build diagnostics.

Point requests default to the first v5 frame. Select frame pages for complete
timelines within the [serving budgets](../../docs/serving-budgets.md).
The [point series loader](src/client-point.ts) fetches samples and profiles
independently and merges them by frame ID. If the selected frame has map lift,
progress waits for its sample request to settle. Progress reports outstanding
requests separately from the frame count. The day view uses the v5 map prefix
when available and the first 24 hours otherwise.
[`PointSeriesController`](src/point-series-controller.ts) owns the open point,
selected hour and current request for each map. Close it to dispose the loader.

```sh
pnpm test packages/client
```
