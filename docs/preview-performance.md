# Preview timeline performance

Prepared timeline input reached a 13.9 ms p95, down from 30.8 ms. Cold delivery still determines first-pass scrolling speed.

```sh
pnpm bench:preview --baseline 99cd00a --channel chrome --repeats 30 --out output/timeline-input-40-final.json
pnpm bench:preview --baseline 99cd00a --channel chrome --scenario cold --delay-ms 250 --out output/timeline-input-250.json
pnpm bench:preview --baseline 99cd00a --channel chrome --scenario cold --delay-ms 500 --out output/timeline-input-500.json
```

## Actual preview input to pixels

The [harness](../scripts/preview-layer-bench.ts) loads each revision’s real `main.ts`, controls and raster overlay. It dispatches synthetic DOM `input` events on `#time`. Timing starts in an input capture listener before the application handler and ends on the first map render whose center and four quadrants match the target frame. There is no extra render guard. Browser compositor presentation and physical input-device latency remain outside this boundary.

At 40 ms injected tile latency, baseline → changed:

- Settled stepping, 30 inputs: p50 **30.0 → 12.9 ms**, p95 **30.8 → 13.9 ms**; all 30 rendered.
- Settled stepping with the actual point Windgram open, 30 inputs: p50 **31.3 → 13.2 ms**, p95 **34.1 → 18.4 ms**; all 30 rendered. Changed maximum was 35.9 ms.
- Warm continuous traversal, inputs every 120 ms: p95 **19.2 → 7.6 ms**; all 23 targets rendered in both versions.
- Warm continuous traversal, inputs every 60 ms: p95 **31.2 → 16.0 ms**; all 23 targets rendered in both versions.

Both warm continuous sweeps made zero tile HTTP requests and painted zero superseded targets. Actual median input intervals were 121.6/122.4 ms and 61.3/61.9 ms respectively. The full day is visited before warm measurements; settled stepping waits for background preparation between inputs, while continuous traversal has no quiet period between inputs.

## Cold traversal

Each cold sweep uses a fresh browser context and starts as soon as the initial frame renders. Of 23 subsequent targets, **only the final target rendered in every cold sweep**; the other 22 were superseded before their pixels arrived. No superseded target was subsequently painted. Final input to final pixels, listed at 120/60 ms input cadence:

- 40 ms per tile: baseline **396/415 ms**, changed **408/375 ms**.
- 250 ms per tile: baseline **2,106/2,115 ms**, changed **2,090/2,092 ms**.
- 500 ms per tile: baseline **4,071/4,096 ms**, changed **4,087/4,105 ms**.

These are individual sweep diagnostics. Four active HTTP requests serving 32 visible tiles require eight response waves for a wholly cold frame. Wider preparation helps warmed interaction; it cannot hide this cold delivery cost. Cold selection cancels unfinished predictions before admitting the new requested source, preventing MapLibre’s image queue from delaying it behind speculative work.

## Retention and cost

The changed preview retained four sources at this viewport. Requested WebGL texture storage peaked at **46.67 MiB**, versus **25.33 MiB** for the two-source baseline. The extra 21.33 MiB matches two 32-tile RGBA frames including mipmaps. Across eight alternating pans and three distant time selections per pan, changed storage stabilized at 37.33–42.67 MiB by the second round; baseline stabilized at 25.33 MiB. Admission is owned by [raster-budget.ts](../apps/preview/src/raster-budget.ts).

Accounting wraps texture allocation and deletion before MapLibre initializes, retaining mip levels and pooled textures in the count. These are logical requested texture bytes; native decoder allocations, driver overhead, renderbuffers and the default framebuffer are outside the count. Final JavaScript heap after forced GC was 23.8 → 24.2 MiB. The complete 40 ms workload started 1,492 → 1,698 tile requests and transferred 21.0 → 23.8 MiB. Peak active HTTP handlers stayed at four.

## Reproduction scope

Captured 13 November 2026, 13:11–13:13 UTC, using Node 22.23.4, Chrome 157.0.8103.79, MapLibre 6.16.0 and Apple M4 Max Metal through ANGLE. Viewport: 1920 × 1080, device scale 1, zoom 7.15, 32 visible forecast tiles. The fixture uses a neutral basemap, opaque patterned 256 × 256 lossless WebP, 24 hourly frames, a real point profile response and controlled local response delays. The map’s drawing buffer is preserved for framebuffer inspection.

All three runs used the same source and harness fingerprints. Source hashes cover preview/client TypeScript and CSS plus the application HTML; test files are excluded.

```text
baseline revision 99cd00a6a5ece1c474fe8d873ca50ce9725362f3
baseline source   b9e74b6e7e1569ea9a1b93fd0e09dd944101a27726d884ec461e51a6f63d2812
changed source    3f38baff747c625dd3647fec8382d769b1d3326fd127517144aeb0a1e8a5b074
harness           80acd80f8b2d89374a44afcabc7296b51068c1e44f6b0509317d91b8a5c2a991
```

The commands retain full samples, superseded counts, final-target HTTP start/end times, source fingerprints and memory snapshots in ignored `output/` JSON files. The full run also saves baseline and changed PNGs. Network bandwidth, real basemap work, mobile hardware and browser compositor latency need separate profiles.

## Live delivery evidence

A separate API probe at 12:55 UTC sampled ICON-EU near the reported location through Cloudflare’s SOF point of presence. Six first-pass tiles at z9, x317/318, y192 and frames f020–f022 took **140–446 ms**; reported R2 work was **63–259 ms**, with one to four storage reads. Repeating those URLs took **46–60 ms**, with zero R2 reads and 2–4 ms of Worker time. Those nighttime payloads were 42-byte empty tiles, so this measures lookup and delivery overhead. Six cached daytime tiles of 3.4–4.1 kB repeated in 47–61 ms with zero R2 reads. This probe ran outside the user’s browser and covers one point of presence.

The next delivery experiment should reduce cold storage and HTTP round trips: compare neighboring-time chunks and tiered CDN delivery against the existing local response cache, then measure first-pass daytime frames from the user’s region. [Serving budgets](serving-budgets.md) own the current cache and request limits.
