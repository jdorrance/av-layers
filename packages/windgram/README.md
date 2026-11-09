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
longitude offset.

[`point-windgram.ts`](src/point-windgram.ts) owns the panel and its lifecycle.
[`from-av-profile.ts`](src/from-av-profile.ts) maps point frames to chart hours.
[`scalar-point.ts`](src/scalar-point.ts) renders the scalar fallback.
