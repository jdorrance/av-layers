# Tile Serving, Client Caching & Flicker-Free Rendering Handoff

Eliminate blank-canvas flicker during timeline scrubbing and layer switching (`usable-lift-agl`, `usable-lift-msl`, `precip-rate`), remove client and Worker tile-loading serialization bottlenecks, make live tile responses immutable at the browser and Cloudflare edge while preserving the expired-build safety contract, add viewport-aware prefetching and zoom pooling, and specify the follow-on multi-channel data-tile + WebGL colormapping path for `windy-av-layer`.

This handoff is written against the active v5 whole-domain codebase ([apps/preview/src/main.ts](../apps/preview/src/main.ts), [apps/windy-plugin/src/raster-layer.ts](../apps/windy-plugin/src/raster-layer.ts), [apps/windy-plugin/src/controller.ts](../apps/windy-plugin/src/controller.ts), [packages/client/src/client-raster.ts](../packages/client/src/client-raster.ts), [packages/client/src/client-view.ts](../packages/client/src/client-view.ts), [apps/api/src/index.ts](../apps/api/src/index.ts), [apps/api/src/http.ts](../apps/api/src/http.ts), [apps/api/src/pmtiles.ts](../apps/api/src/pmtiles.ts), [apps/api/src/publication.ts](../apps/api/src/publication.ts), and [apps/api/src/coverage.ts](../apps/api/src/coverage.ts)).

```sh
git status --short
pnpm exec node --version
pnpm verify
```

## Implementation & Measurements

Milestones 1–3 are implemented in this branch. [Measurement results](tile-serving-performance-results.json) own the recorded timings, byte counts, fixture scope, and browser checks.

- Both clients keep a committed overlay visible while a replacement loads, use one session protocol, and prefetch viewport candidates after idle. A tile that fails stays in the staging image and the committed frame remains. A source failure, or a settled viewport with no successful tiles, releases only the staging slot. Expiry clears both slots.
- The client default is four active requests, at most two of them prefetch, with the existing queue of 64. In a local synthetic Worker workload with 40 ms injected HTTP delay, the 32-tile viewport median fell from 738 ms at two requests to 371 ms at four. The same run was 194 ms at eight and 155 ms at twelve, with no failures and 1460 cached bytes. Concurrency stays at four because the Worker tile-read pool is four. Warm client repeats made zero additional network requests.
- Worker product validation and PMTiles range reads coalesce within the existing serving limits. Retained-entry and expiry checks precede cached delivery. Catalog, latest, and retained-run discovery use short edge caching with browser revalidation (§6.1). Batch output and published tile formats remain unchanged.
- Phase 2 remains an evaluated data-tile prototype. On 48 native ICON-EU tile/frame pairs, the 25 m candidate used 0.90× the raster bytes and changed 7.44% of layer-pixels. The 1 m candidate used 2.78× the bytes and changed 0.30%. Both ran at encoder effort 1 against raster effort 4. Preserve the raster path until a candidate passes the forecast, storage, build-time, and browser gates in §7.
- Renderable coarse-parent pinning, coarse-byte warm-up, and publication prewarming await their measurement gates. Current idle prefetch covers adjacent frames, sibling lift, and the viewport perimeter.

Repeat the transport workload against the local synthetic API and the data pilot against a local version-3/version-4 native sample pack:

```sh
pnpm exec node --import tsx scripts/tile-transport-bench.ts http://127.0.0.1:8798
pnpm exec node --import tsx scripts/tile-data-bench.ts /path/to/manifest.json 1 25
pnpm exec node --import tsx scripts/tile-data-bench.ts /path/to/manifest.json 1 1
```

## 1. Serving Paths & Baseline Measurements

Measure these client and Worker paths during panning, zooming, timeline scrubbing, and layer switching. Record request counts, cancellations, decode time, blank-overlay duration, and storage reads before selecting new limits. Rows 1–3 describe the client before milestones 1–3. The implementation section records the current overlay and transport behavior.

| # | Bottleneck | Exact Source Location | Root Cause & User-Visible Symptom |
| :- | :--- | :--- | :--- |
| **1** | **Destructive MapLibre source/layer teardown on every frame or layer switch** | [apps/preview/src/main.ts](../apps/preview/src/main.ts#L302) (`updateOverlay` → `removeOverlay`) | Every `input` event on the time slider or click on `AGL`/`MSL` calls `removeOverlay()`, which removes `OVERLAY_LAYER_ID`, removes `overlaySourceId`, disposes `overlayProtocol` (aborting all in-flight tile requests), unregisters the MapLibre protocol, and mounts a brand-new `overlaySourceId` from scratch. MapLibre immediately clears the overlay canvas to blank until the new tiles finish downloading and decoding—causing a 100% blank flash on every step. |
| **2** | **Per-switch random UUID protocol scheme defeats MapLibre’s internal `TileCache`** | [packages/client/src/client-raster.ts](../packages/client/src/client-raster.ts#L19) (`av-raster-${crypto.randomUUID()}`) | Each `createRasterTileProtocol()` call generates a new `av-raster-<uuid>://` scheme. Even if the user toggles `AGL → MSL → AGL` or scrubs `h002 → h003 → h002` within 1 second, the scheme prefix has changed, so neither MapLibre’s internal tile pyramid cache nor the disposed protocol instance can reuse a single decoded tile. |
| **3** | **Client concurrency is throttled to `maxActive = 2` with FIFO queuing** | [packages/client/src/client-raster.ts](../packages/client/src/client-raster.ts#L21) | Two active requests serve each overlay. FIFO scheduling places older queued tiles ahead of newer viewport requests. Measure viewport completion and cancellation before selecting concurrency and priority changes (§4.1). |
| **4** | **Publication validation runs before the tile cache** | [apps/api/src/index.ts](../apps/api/src/index.ts), [apps/api/src/publication.ts](../apps/api/src/publication.ts) | Cold isolates load the pointer and manifest before a response-cache hit. Warm manifest loads still validate product descriptors and grid hashes. Pointer refreshes follow their own TTL. Memoize successful static validation while preserving admission before cache delivery (§6.1). |
| **5** | **Uncoalesced PMTiles header/directory R2 reads & `MaterializedReads(4)` bottleneck** | [apps/api/src/pmtiles.ts](../apps/api/src/pmtiles.ts#L39), [apps/api/src/coverage.ts](../apps/api/src/coverage.ts#L92) | `tileReads` caps concurrent tile loads per isolate at **`4`** (`new MaterializedReads(4)`) and keys by `${key}:${z}:${x}:${y}`. When 12 tiles for a cold frame `h001.pmtiles` arrive at once, `PMTiles.getHeader()` and root/leaf directory reads inside `R2Source.getBytes(offset, length)` are **not** coalesced across different `(z, x, y)` keys—issuing duplicate R2 range reads for the exact same `16 KiB` PMTiles header and directory ranges. |
| **6** | **Intermediate zoom requests compete with settled-camera work** | [apps/preview/src/main.ts](../apps/preview/src/main.ts), [apps/windy-plugin/src/raster-layer.ts](../apps/windy-plugin/src/raster-layer.ts) | Trace requested zoom levels, cancellations, and queue time during rapid zoom gestures in each map engine. Use those traces to choose idle-prefetch cancellation and any later zoom-step policy (§5.2). |

## 2. Hard Invariants & Architectural Decisions

Every milestone in this handoff must preserve the following repository invariants:

1. **Build Pinning, Rollback & Expiry:**
   - Build-specific tile URLs identify immutable bytes. [Rollback](../apps/batch/src/publication.ts) changes `latestBuildId` and preserves `retained`; clients already pinned to an unexpired retained build keep viewing it. [Operations](operations.md#roll-back-or-clean-up) owns that behavior.
   - Emit `Cache-Control: public, max-age=${ttl(expiresAt)}, immutable` on successful build-specific tile, manifest, provenance, and TileJSON responses. Keep the existing `ttl()` calculation in [http.ts](../apps/api/src/http.ts), which bounds freshness by `expiresAt`.
   - Catalog, latest, and retained-run discovery use `public, max-age=0, s-maxage=<remaining freshness>, must-revalidate`. Bound edge freshness by the pointer cache's existing deadline and live build expiries. Health checks and errors keep `no-store`.
   - Every Worker tile request passes current retained-entry, expiry, and publication validation before response-cache delivery (§6.1). Clients enforce `expiresAt` on compressed cache hits, queued work, and rendered overlays, including after focus and BFCache restoration.
   - Fresh browser responses can be reused until their freshness deadline under [RFC 8246](https://www.rfc-editor.org/rfc/rfc8246.html). Emergency revocation before expiry requires a separate browser admission protocol; this plan preserves the current retention contract.
2. **Bounded Worker & Client Memory Budgets:**
   - [Serving budgets](serving-budgets.md) and [resources.ts](../apps/api/src/resources.ts) own Worker limits. Keep the current directory-cache and tile-read defaults until the measurement gate in §6.2 passes.
   - [createRasterTileProtocol](../packages/client/src/client-raster.ts) owns the client cache budget, including payload and estimated entry storage. Expiry and disposal purge the cache. Include decoded textures and staging slots in browser-memory measurements (§8).
3. **Why Keep Lossless `VP8L` WebP for Pre-Colored Raster Tiles (Milestones 1–3):**
   - [webp.ts](../apps/batch/src/webp.ts) owns the existing lossless encoder; [palette-color.ts](../packages/contracts/src/palette-color.ts) owns palette quantization. Retain these outputs during Milestones 1–3.
   - Milestone 4 evaluates multi-channel data tiles and WebGL colormapping under the encoding and measurement gates in §7.

## 3. Sources of Truth

Inspect these files before editing:

- **Shared Client Protocol & View Helpers:** [packages/client/src/client-raster.ts](../packages/client/src/client-raster.ts), [packages/client/src/client-raster.test.ts](../packages/client/src/client-raster.test.ts), [packages/client/src/client-view.ts](../packages/client/src/client-view.ts), [packages/client/src/client-view.test.ts](../packages/client/src/client-view.test.ts), [packages/client/src/client-api.ts](../packages/client/src/client-api.ts)
- **Preview Application (MapLibre GL):** [apps/preview/src/main.ts](../apps/preview/src/main.ts), [apps/preview/src/main.test.ts](../apps/preview/src/main.test.ts), [apps/preview/src/style.css](../apps/preview/src/style.css)
- **Windy Plugin (LeafletGL / MapLibre):** [apps/windy-plugin/src/raster-layer.ts](../apps/windy-plugin/src/raster-layer.ts), [apps/windy-plugin/src/raster-layer.test.ts](../apps/windy-plugin/src/raster-layer.test.ts), [apps/windy-plugin/src/controller.ts](../apps/windy-plugin/src/controller.ts), [apps/windy-plugin/src/controller.test.ts](../apps/windy-plugin/src/controller.test.ts)
- **Cloudflare Worker API & PMTiles Reader:** [apps/api/src/index.ts](../apps/api/src/index.ts), [apps/api/src/http.ts](../apps/api/src/http.ts), [apps/api/src/pmtiles.ts](../apps/api/src/pmtiles.ts), [apps/api/src/publication.ts](../apps/api/src/publication.ts), [apps/api/src/coverage.ts](../apps/api/src/coverage.ts), [apps/api/src/resources.ts](../apps/api/src/resources.ts), [apps/api/test/worker.test.ts](../apps/api/test/worker.test.ts)

## 4. Milestone 1: Client Transport, Caching & Priority Scheduling (`@av/client`)

### 4.1 Upgrade `createRasterTileProtocol` (`packages/client/src/client-raster.ts`)

`createRasterTileProtocol` ([packages/client/src/client-raster.ts](../packages/client/src/client-raster.ts)) admits 4 requests, queues 64, and leaves interactive capacity while prefetch is active. `maxPrefetchActive` defaults to `Math.min(2, Math.max(1, maxActive - 2))`. One scheme lasts for the mounted map. Identical URLs coalesce, and compressed tiles stay in a 48 MiB cache until build expiry or pressure. Expired entries leave the cache when the next tile is admitted.

#### Required Changes
1. **Concurrency, Queue Depth & Priority Scheduling:**
   - Benchmark `maxActive = 2` against candidates up to `12`, retaining existing option bounds. Measure the current `maxQueued = 64` before considering `256`. Select the smallest limits that improve viewport completion without increasing failures or exceeding the measured browser-memory budget (§8).
   - Separate interactive viewport loads from background prefetch loads via two priority lanes:
     - **Interactive lane (`priority: 'interactive'`):** Dispatched in **LIFO + zoom-coarseness order** (most recent camera request first, with coarser `z` breaking ties so parent fallback tiles complete before high-zoom children).
     - **Prefetch lane (`priority: 'prefetch'`):** Dispatched when capacity remains and `activePrefetch < maxPrefetchActive` (default `Math.min(2, Math.max(1, maxActive - 2))`). Interactive work takes priority over queued prefetch work.
2. **In-Memory Byte-Bounded Tile LRU Cache & In-Flight Coalescing:**
   - Keep an in-memory LRU inside `createRasterTileProtocol` bounded by `maxCacheBytes`, accounting for payload, URL, and entry storage:
     - Key by canonical tile URL (`https://.../tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp`).
     - Store `{ data: ArrayBuffer; cacheControl?: string; expires?: string; expiresAtMs: number; byteLength: number }`.
     - Return a fast slice/copy (or shared immutable `ArrayBuffer` when the caller does not detach it; note MapLibre workers transfer `ArrayBuffer` across `postMessage`, so `load()` must return `entry.data.slice(0)` on cache hits so cached bytes are never detached!).
   - **Coalesce concurrent in-flight fetches** for the same canonical tile URL: if a prefetch for `(frame, z, x, y)` is already in flight when the user scrubs onto `frame`, promote the in-flight request to interactive priority and resolve both callers from the same response buffer (`data.slice(0)`).
3. **Expose Prefetch, Build Expiry, Eviction & Cache Stats:**
   - [RasterTileProtocol](../packages/client/src/client-raster.ts) owns the interface. Register each pinned build through `setBuildExpiry()` before loading or prefetching tiles; `evictBuild()` releases its queued, active, and cached work.
   - `dispose()` aborts all in-flight and queued requests and clears the byte cache so expired builds release memory immediately.

## 5. Milestone 2: Flicker-Free Layer/Frame Swapping, Zoom Pooling & Viewport Prefetching (`apps/preview`, `apps/windy-plugin`)

### 5.1 Non-Destructive Double-Buffered Overlay Updates in `apps/preview/src/main.ts`

#### Implemented behavior
`RasterOverlay.select` mounts the requested frame in a hidden staging source. A successful render raises that source and retires the previous one on the next microtask. `removeOverlay()` runs when the build expires and when the map is torn down. Loading copy uses the status toast. A failed replacement uses the alert toast and keeps the committed frame on screen.

#### Required Fix
1. **Single Session-Lived `RasterTileProtocol` per Mounted Map:**
   - Register **one** `overlayProtocol = createRasterTileProtocol(apiBaseUrl)` when `startPreview()` initializes the map, and keep its scheme registered across frame, `AGL ↔ MSL`, and model transitions (calling `overlayProtocol.evictBuild(previousBuildId)` when switching models or expiring a build, and `overlayProtocol.dispose()` only on `pagehide` / map teardown).
2. **Commit Successful Overlay Replacements (`activeSlot` / `stagingSlot`):**
   - Keep two source/layer slots, `av-overlay-a` and `av-overlay-b`. The active slot owns the committed `(model, buildId, layer, frame)`; the staging slot loads the requested selection with `raster-opacity: 0` while the active slot stays visible.
   - Give each requested selection a fresh staging source identity and retire superseded staging work first. Keep at most two mounted slots. Track successful loads, errors, and cancellation against that source generation and camera so late events from earlier URLs cannot satisfy readiness.
   - Commit when the current generation's viewport tiles have loaded successfully and its source is ready for rendering. `isSourceLoaded()` is one readiness signal: [MapLibre's tile manager](https://github.com/maplibre/maplibre-gl-js/blob/v6.16.0/src/tile/tile_manager.ts) also treats errored tiles as settled. Combine it with successful tile coverage and a render event before retiring the old slot. A timer may report slow loading; successful readiness controls every swap, including warm-cache swaps.
   - On failure, retain the live committed slot, show its frame/layer with a pending or failed-selection message, and release failed staging work. Superseding selections invalidate older generations. A camera change recomputes readiness. Build expiry removes both slots and cancels their work.
   - Apply the same commit rules in the Windy adapter and controller. Extend their private tile-event handling only as needed to identify staging readiness; closing the pane preserves the overlay lifecycle described in the [plugin README](../apps/windy-plugin/README.md).
3. **RAF-Coalesced Timeline Scrubbing (`apps/preview/src/main.ts:456`):**
   - On `timeInput` `input` events, update the timestamp label (`clockLabel`) and day-bar highlight immediately on every pointer move, and schedule the tile source switch via `requestAnimationFrame` (coalescing multiple pointer events within a 16 ms frame) with URL `history.replaceState` deferred to `change` / idle.

### 5.2 Zoom Pooling & Coarse-to-Fine Anchor Tiles (`packages/client/src/client-view.ts`, `apps/preview/src/main.ts`)

1. **Bounded Coarse-Tile Warm-Up (`z = 4` and `z = 6`):**
   - When a build loads or the camera settles (`moveend`), compute covering coordinates at `z = Math.min(4, maxZoom)` and `z = Math.min(6, maxZoom)`. Deduplicate them and share the idle prefetch budget in §5.3.
   - `prefetch()` retains compressed bytes. [MapLibre's parent fallback](https://github.com/maplibre/maplibre-gl-js/blob/v6.16.0/src/tile/tile_manager.ts) uses tiles already loaded into its pyramid. Measure whether byte warm-up improves completion before adding retained coarse sources or decode/upload work. The committed slot supplies continuity during selection changes (§5.1). Keep coarse prefetch when measurements show a latency improvement.
   - Any later parent-pinning implementation must load and retain renderable parents through the map adapter, bound decoded CPU/GPU memory, and demonstrate parent rendering while fine tiles are delayed in browser tests.
2. **Gesture Scheduling:**
   - Start background prefetch after the camera settles. On `movestart` / `zoomstart`, cancel obsolete prefetch work and let interactive loads use the configured concurrency. Shared fetches continue while they have interactive consumers. Measure intermediate-zoom traffic before choosing a zoom-step policy.

### 5.3 Viewport-Aware Idle Prefetcher (Adjacent Hours + Sibling Layer + Panning Ring)

Use the shared `viewportTiles()` and pure `planViewportPrefetch()` in [client-view.ts](../packages/client/src/client-view.ts). Their types own the inputs and URL result for both map adapters.

When the camera has settled and active viewport tiles have loaded, enqueue `overlayProtocol.prefetch(url)` in utility order, capped at 64 URLs per idle cycle including coarse warm-up. Use MapLibre's `idle` event or a debounced check of camera and source readiness:

1. **Next forecast frame (`frameIndex + 1`)** for the current viewport tiles on `activeLayer`,
2. **Previous forecast frame (`frameIndex - 1`)** for the current viewport tiles on `activeLayer`,
3. **Sibling lift layer (`usable-lift-msl` when viewing `usable-lift-agl`, and vice versa)** for the current `activeFrame` and viewport tiles,
4. **Second forward frame (`frameIndex + 2`)** for the current viewport tiles on `activeLayer`,
5. **1-tile perimeter ring** around `viewportTiles` at the current zoom `z` on `(activeLayer, activeFrame)` (makes small pans seamless).

Filter all candidate `(z, x, y)` coordinates against `build.manifest.descriptors.bounds` and `[0, 2^z)` (wrapping `x` only when the surface grid has `wrapLongitude: true`) so out-of-bounds tiles are never prefetched.

## 6. Milestone 3: Validated Cache Delivery & Coalesced PMTiles Reads (`apps/api`)

### 6.1 Reuse Successful Validation & Add `immutable` (`apps/api/src/publication.ts`, `apps/api/src/http.ts`)

1. **Use Response-Specific Cache Policies:**
   - [http.ts](../apps/api/src/http.ts) owns the policies. Successful build-specific responses use expiry-bounded `public, max-age=..., immutable`. Palette responses use `public, max-age` and stay revalidatable because the palette URL is stable.
   - Successful `/v1/catalog`, `/v1/models/:model/latest` (including `expand=manifest`), and retained-run lists use `public, max-age=0, s-maxage=..., must-revalidate`. Store their bounded bodies through `caches.default`; [Cloudflare honors `s-maxage` separately from browser freshness](https://developers.cloudflare.com/cache/concepts/cache-control/).
   - Compute each discovery response's deadline from the remaining pointer-cache lifetime and live build expiries. Catalog responses use the earliest participating deadline, including unavailable-model pointers. Cache keys distinguish pointer contents and representation. Keep publication validation before cached delivery.
   - Browser requests revalidate discovery metadata. Refreshing an edge response preserves the pointer's existing deadline. Health, invalid requests, expired builds, rate limits, and operational errors remain uncached.
   - Verify browser/edge header behavior and actual response-cache hits in `apps/api/test/worker.test.ts`, including cache-disabled mode.
2. **Preserve Admission Before Cache Delivery:**
   - Keep the tile handler's order: validate URL syntax, `admit()`, `manifest()`, artifact/frame/layer and coordinate validation, then `cached(..., m.expiresAt, ...)`. Keep existing legacy coverage validation before the response-cache lookup. A cold manifest is loaded and validated even when the tile response is cached.
   - Memoize successful static manifest/product validation inside `publication.ts`, including recipe, descriptors, grids, and grid hashes. Associate the result with the cached manifest and the immutable deployed product identity. Bound retained validation state by the manifest cache; concurrent checks may share pending work, and failures release it for retry.
   - Recheck retained-entry binding and expiry on every request. A new product identity or manifest eviction requires full static validation again. Keep product-dependent validation separate from the artifact index already cached by manifest identity.
   - With pointer, validated manifest, and required coverage entries warm, a response-cache hit should perform zero R2 reads and reuse static validation. Measure latency. Preserve rejection of incompatible retained builds across deployments, including when `caches.default` contains a successful response from the previous deployment.

### 6.2 Coalesce PMTiles Reads Within Measured Budgets (`apps/api/src/pmtiles.ts`)

1. **Coalesce Concurrent Archive Range Reads in `R2Source.getBytes` ([apps/api/src/pmtiles.ts](../apps/api/src/pmtiles.ts#L39)):**
   - Add a per-bucket range read coalescer around `R2Source.getBytes`, sharing materialized bytes and response metadata. Bound its concurrency by the existing tile-read concurrency and use the current `MaterializedReads` queue, waiter, deadline, and allocation limits from [resources.ts](../apps/api/src/resources.ts).
   - Key `R2Source.getBytes(offset, length, signal, etag)` by `${this.key}:${offset}:${length}:${etag ?? ''}`.
   - Concurrent consumers of the same header or directory range share one R2 read. A cancelled consumer releases its wait while remaining consumers finish. Count coalesced reads through existing metrics. Raw-range sharing still permits separate directory decompression and parsing; measure those allocations and CPU.
2. **Measure Before Raising Limits:**
   - Start with the existing `DirectoryCache` and `tileReads` defaults in [pmtiles.ts](../apps/api/src/pmtiles.ts). Benchmark coalescing before considering the proposed 12 MiB directory cache, 512 entries, or 16 concurrent tile reads.
   - Run cold viewport bursts and the sustained cache-on/cache-off workload in [serving budgets](serving-budgets.md#runtime-and-load-checks). Record peak memory, allocation-pool usage, R2 reads/bytes, directory parse/decode work, p50/p95 latency, timeouts, and 503 responses.
   - Select the smallest configuration that improves viewport completion without increasing failures. Require measured memory within the Worker limit with the runtime headroom in the serving budget, including mixed tile/sample/provenance load. Account for cache growth and concurrent transient allocations; update the modeled envelope and evidence in `serving-budgets.md` with any admitted limit change.

### 6.3 Post-CAS Edge & Directory Pre-Warming (`scripts/publication-workflow.ts`)

In `verifyPublishedForecast()` ([scripts/publication-workflow.ts](../scripts/publication-workflow.ts)):
- Evaluate a bounded warm-up alongside the existing smoke checks. [Cloudflare's Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/) stores responses in the data center reached by the request; isolate caches follow the handling isolate. Measure the benefit at that location before adding requests to publication verification.

## 7. Milestone 4 (Phase 2 Architecture): Multi-Channel Data Tiles + WebGL LUT Shader

Once Milestones 1–3 are live, evaluate client-side GPU colormapping for layer switching, hover readouts, and temporal interpolation. Measure browser memory, decode time, frame rate, wire bytes, and batch cost against the raster path before adopting a data-tile format.

### 7.1 Versioned Scalar Encoding & Browser Byte Preservation

Prototype lossless `VP8L` tiles that carry lift, precipitation, status, and support data on a shared pyramid. Select the encoding after these checks:

1. **Range and Precision:**
   - Define a versioned encoding descriptor with each field's signed range, scale/offset or LUT, byte allocation, missing-value representation, and quantization-error bound. [Layer palettes](../packages/contracts/src/layers.ts) and [columnResult()](../packages/forecast/src/science.ts) own the current ranges and value semantics.
   - Preserve valid negative MSL values and lift above 6375 m, including the palette's upper range. Choose higher bit depth or additional byte planes when required. An input outside the declared range rejects the candidate data encoding and retains the raster path; valid values must survive without silent saturation.
   - Preserve layer-specific status and support through resampling and encode/decode. Compare palette output around existing thresholds and record permitted color error before selecting a quantizer. Separate scalar quantization error from spatial resampling error in hover accuracy claims.
2. **Byte-Preserving Decode and Upload:**
   - Keep exact encoder bytes, including RGB under zero alpha. Decode and upload with alpha premultiplication and color conversion disabled. For a MapLibre raster source, use [setPremultiplyAlpha(false)](https://github.com/maplibre/maplibre-gl-js/blob/v6.16.0/src/source/raster_tile_source.ts); a custom path must set equivalent image-decode and texture-upload controls and verify the resulting GPU texels.
   - Packed alpha represents flags. The shader derives display opacity from decoded status and the user's opacity setting. Sample flags and multi-byte scalar codes with nearest-neighbor texel access, then apply the forecast interpolation rules explicitly.
   - Gate each supported browser path on byte-exact round trips through encoding, decode, texture upload, and readback. Include alpha zero, every supported flag combination, scalar extremes, and values above 6375 m. A failed or unsupported path keeps the existing raster renderer.

### 7.2 WebGL Colormapping & Client Interactions

- **Layer Selection:** Select a decoded scalar field and its palette through shader uniforms. Measure switching latency with all required textures resident.
- **Temporal Scrubbing:** Prototype interpolation between two resident frames with explicit unavailable/no-lift handling and valid-time labeling. Compare forecast behavior and frame rate with discrete-frame swaps.
- **Hover Readout:** Decode resident scalar/status data for approximate hover values, reporting the tested encoding and resampling accuracy. Keep `/sample` as the source for point tables. Include CPU/GPU retention and readback cost in the browser-memory and frame-time measurements.

## 8. Verification & Acceptance Checklist

1. **Automated Unit & Integration Tests (`pnpm verify`):**
   - `packages/client/src/client-raster.test.ts`:
     - Verify configured concurrency, queue bounds, deadlines, and prefetch caps.
     - Verify LIFO priority scheduling serves the newest interactive viewport tiles ahead of older queued tiles, and interactive requests preempt queued `prefetch` requests.
     - Verify in-memory tile LRU cache hits return non-detached `ArrayBuffer` copies (`cacheHits` increments, `fetchImpl` called once), respect `maxCacheBytes`, and stop serving expired builds. Test eviction and cancellation through `evictBuild()` / `dispose()`.
     - Verify concurrent `load()` and `prefetch()` calls for the same URL coalesce into a single `fetchImpl` call.
   - `packages/client/src/client-view.test.ts`:
     - Verify `planViewportPrefetch` orders URLs as `frame+1` → `frame-1` → sibling lift layer → `frame+2` → 1-tile perimeter ring and filters out coordinates outside `bounds` or `[0, 2^z)`.
   - `apps/preview/src/main.test.ts` & `apps/windy-plugin/src/controller.test.ts`:
     - Verify successful staging-generation readiness before committing frame/layer changes. Delay loads beyond 150 ms, fail or abort tiles, change the camera, and supersede the selection; the live committed overlay remains visible with accurate loading/error labels. Expiry clears both slots and cancels work.
     - Verify session protocol and expiry handling across pagehide/pageshow, including BFCache restoration.
   - `apps/api/test/worker.test.ts`:
     - Verify `Cache-Control: public, max-age=..., immutable` on live tile/manifest responses.
     - Verify discovery responses use browser revalidation and short shared freshness, return response-cache hits, and change with pointer contents. Exercise catalog availability, expanded latest, retained-run expiry, rollback, and configuration changes. Pointer and response-cache lifetimes together must remain within the existing discovery freshness bound; health and error responses keep `no-store`.
     - Verify a response-cache hit passes admission, publication, artifact, and coordinate checks first. With pointer, validated manifest, and required coverage caches warm, expect zero R2 reads. Cold manifests still load and validate before cache delivery.
     - Seed cached responses from an incompatible product configuration or old coverage; reject them before response-cache lookup. Test retained-entry mismatches, failed-validation retries, and manifest eviction followed by revalidation.
     - Verify rollback changes latest discovery while the previous retained build remains viewable until expiry. Test expiry before cache delivery and retention removal after pointer refresh separately.
     - Verify concurrent cold tile requests at the current Worker limit share header/directory ranges (`x-av-coalesced > 0`, single header range read). One cancelled consumer must leave remaining consumers able to finish; queued reads, waiters, and allocations remain bounded.
2. **Browser and Resource Gates:**
   - In preview and Windy, exercise cold/warm scrubbing, layer changes, panning, zooming, failures, and expiry using the actual map engines. Check visible output as well as source counts; a loaded source may contain failed tiles.
   - Measure coarse byte warm-up separately from renderable parent fallback. Any parent-pinning candidate must display the expected coarse frame while fine tiles are delayed and stay within a measured decoded CPU/GPU memory budget.
   - Record the client and Worker workloads from §§1, 4.1, and 6.2 before increasing limits. Keep current limits when the latency, memory, or failure criteria fail.
   - Gate Phase 2 on range/precision, palette, flags, and GPU byte-roundtrip checks from §7.1. Include negative MSL values, 6600 m lift, overflow rejection, alpha zero, and the raster fallback.
3. **Repository Checks:**
   - Run `pnpm verify` from the repository root; [README.md](../README.md#development-checks) owns the required checks.
