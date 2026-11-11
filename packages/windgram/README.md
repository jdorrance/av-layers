# `@av/windgram`

Mount a point popup with sampled map lift and the native atmospheric chart.

```ts
import { disposePointWindgram, renderPointWindgram } from '@av/windgram';

const update = renderPointWindgram(pointBody, { frames }, build, {
  point, frameId, unitSystem, totalFrames, loading, onFrame: id => selectFrame(id)
});
update(nextFrameId);
disposePointWindgram(pointBody);
```

Pass each loader progress result to `renderPointWindgram`. The lift readout uses
the sampled AGL and MSL values while the profile loads. The MSL chart shows native
levels above model ground and preserves map lift below it. The scalar chart
covers builds that publish no native profiles. Day tabs use the point’s
longitude offset. CAPE and gust labels follow the pinned layer descriptors.

[`point-windgram.ts`](src/point-windgram.ts) owns the panel and its lifecycle.
[`scalar-point.ts`](src/scalar-point.ts) renders the scalar fallback.

`@av/windgram/model` converts validated point frames, builds a chart view, and
reads weather at a selected height without a browser document.

```ts
import { buildWindgramView, createPointForecast, readWindgram } from '@av/windgram/model';

const forecast = createPointForecast(build, point)(build.manifest.frames, framesById);
const view = buildWindgramView(forecast, { unitSystem: 'metric', timeZone: forecast.site.timeZone });
const reading = readWindgram(view, 0, 1500);
```

`readWindgram` accepts a zero-based chart hour and metres MSL.
Each reading names its units and uses `null` for missing weather.
