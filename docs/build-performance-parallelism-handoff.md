# Build Performance, Parallelism & High-Zoom Promotion Handoff

> **Status:** Milestones 1–4 and high-zoom promotions (**GFS `k=10` at `z=9`**, **ICON-EU `k=5` at `z=10`**, and **RRFS `k=2` at `z=10`** in [models.json](../packages/contracts/config/models.json)) are implemented on `main` (`#36`–`#48`). Retained as the architecture and optimization specification record.

Measure and optimize end-to-end build and publication wall-clock time for the shipping whole-domain terrain-column pipeline (**GFS `k=10` at `z=9`**, **ICON-EU `k=5` at `z=10`**, and **RRFS `k=2` at `z=10`** in `apps/batch/src/whole-domain/`), fix current baseline blockers in sparse-coverage API admission, sample-pack chunk alignment, and whole-domain raster-worker admission, eliminate cross-shard sample-pack merging and redundant GitHub Actions artifact transfers, parallelize per-frame derivation with bounded shared-memory lifetimes, and establish separate, measurement-gated promotion paths for **GFS `k=25`** and **higher native zooms (`z=9–10`)**.

This handoff is a standalone follow-on specification to [whole-domain-refinement-handoff.md](whole-domain-refinement-handoff.md), written against the active v5 whole-domain implementation (`apps/batch/src/whole-domain/`, `apps/batch/src/sample-pack-v5.ts`, `packages/contracts/src/publication.ts`, `apps/api/src/coverage.ts`, and `apps/api/src/sample.ts`).

```sh
git status --short
pnpm exec node --version
pnpm verify
```

---

## 1. Scope, Deadline Contract & Fan-Out Execution Rules

### 1.1 Primary Scope vs. Gated Promotions
1. **Primary Deliverable (Milestones 1–4):**
   - Fix the three immediate baseline/serving prerequisites (Section 3.1) and optimize the shipping whole-domain configuration (**ICON-EU `k=5` at `maxNativeZoom: 8`** and **GFS `k=10` at `maxNativeZoom: 7`**, Africa excluded, GFS precipitation on its native surface).
   - Deliver **both** baseline and post-optimization full-domain build and serving receipts on comparable inputs within the enforced `BUILD_BUDGETS.elapsedMs` deadline contract (**45 minutes** hard ceiling; **20 minutes** is an unproven optimization target to be evaluated against the measured critical path).
2. **Separately Gated Promotions (Milestone 5):**
   - **8-shard fan-out**, **GFS `k=25`**, and **higher native zooms (`z=9`, `z=10`)** are **not** bundled into the initial rollout. Because `z=10` increases tile counts by `~14×` (ICON-EU) to `~50×` (GFS), each step (`4 vs. 8` shards, `k=25`, `z=9`, `z=10`) requires its own full-domain build measurement, R2 storage/operation accounting, Worker memory check, and runner-cost justification before promotion.

### 1.2 Explicit Publication Deadline Contract
Reconcile the operational wall-clock ceiling with `BUILD_BUDGETS.elapsedMs` ([capacity.ts](../apps/batch/src/capacity.ts#L13)) and [publication-workflow.ts](../scripts/publication-workflow.ts#L49):
1. **Start and End Boundaries:**
   - `createdAt` is stamped once in `createBuildPlan` (or `buildForecast` for sequential builds).
   - Persist `deadlineAt = new Date(Date.parse(createdAt) + BUILD_BUDGETS.elapsedMs).toISOString()` in `plan.json` (tightening `BUILD_BUDGETS.elapsedMs` from `50 * 60_000` to `45 * 60_000` once Milestones 1–4 are verified).
   - Propagate `AbortSignal.timeout(Math.max(1, Date.parse(plan.deadlineAt) - Date.now()))` through `prepare`, `shard`, and `build-publish`.
2. **Pre-CAS Reserve vs. Post-CAS Committed Outcome:**
   - Before `publish()` executes `casPointer` ([publication.ts](../apps/batch/src/publication.ts#L114)), enforce `now() <= Date.parse(plan.deadlineAt) - SMOKE_VERIFY_RESERVE_MS` (`60_000 ms` reserve) in addition to `assertLifetime` and `assertUsefulHorizon`.
   - Preserve the post-CAS rule in [publication-workflow.ts](../scripts/publication-workflow.ts#L56): once `casPointer` commits `catalog/<model>/latest.json`, the build is live (`publication: 'committed'`). Any timeout or error during subsequent `cleanup()` or `verifyPublishedForecast()` must record `publication: 'committed'` in `publication.json` / `maintenance.json` / `serving.json` and must never roll back or masquerade as an uncommitted build failure.
   - Track GitHub Actions runner queue wait time (prior to `createBuildPlan`) separately from the build's `createdAt -> casPointer` deadline.

### 1.3 Hard Invariants for Subagent / LLM Task Fan-Out
When splitting this handoff across multiple tasks or subagents, every task must enforce these rules:
- **Target the shipping `whole-domain` pipeline:** Configured whole-domain products execute `prepareWholeDomain` / `loadFrozenWholeDomain` ([whole-domain/prepare.ts](../apps/batch/src/whole-domain/prepare.ts)), `admitWholeDomain` ([whole-domain/capacity.ts](../apps/batch/src/whole-domain/capacity.ts)), `buildWholeDomainFrames` ([whole-domain/frames.ts](../apps/batch/src/whole-domain/frames.ts)), and `finishWholeDomain` ([whole-domain/finish.ts](../apps/batch/src/whole-domain/finish.ts)). Do not apply whole-domain optimizations only to legacy `buildFrames` ([frame-build.ts](../apps/batch/src/frame-build.ts)).
- **Never break `Float32` / `Float64` numerical or RGBA parity:** Do not replace `Float64` grid-sampling fractions (`rows.fraction`, `columns.fraction`) with `Float32`, do not alter `snapGridCoordinate` or `reduceKnownQuad` / `reduceCells` accumulation order in [sampler.ts](../packages/forecast/src/sampler.ts), and do not use lossy sample encoding.
- **Namespace every sample object by `surface.id` and validate canonical `buildId`s:** Reuse `/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/` ([build.ts](../apps/batch/src/build.ts#L27)) and validate sample shard keys by exact string equality against `builds/${manifest.model}/${manifest.buildId}/surfaces/${surface.id}/samples/g${group}-b${blockShard}.bin`.
- **Mandatory R2 `customMetadata.sha256` Postcondition:** Because `serveSampleV5` ([api/sample.ts](../apps/api/src/sample.ts#L161)) rejects any sample shard where `object.customMetadata?.sha256 !== shard.sha256` with `503 publication-incomplete`, `verifyRemoteHash` **cannot** repair missing or mismatched `customMetadata.sha256`. Every sample shard in R2 must carry verified `customMetadata.sha256 === shard.sha256` before pointer CAS.
- **Queue `MaterializedReads` before rejecting:** Add a bounded FIFO admission queue with deadline/cancellation and in-flight coalescing in [resources.ts](../apps/api/src/resources.ts).
- **Abort in-flight prefetch immediately on failure and write directly into the 2-slot `SharedArrayBuffer` ring:** Decode GRIB fields directly into pre-allocated `SharedArrayBuffer` frame slots (no transient 3rd full-frame copy), and abort a locally owned `AbortController` on the first `derive`/`pack`/`render` error before draining prefetch and closing the provider.

---

## 2. Sources of Truth

Inspect the current checkout before editing:

- **Contracts & Schemas:** [publication.ts](../packages/contracts/src/publication.ts), [coverage.ts](../packages/contracts/src/coverage.ts), [sparse-coverage.ts](../packages/contracts/src/sparse-coverage.ts), [format.ts](../packages/contracts/src/format.ts), [models.json](../packages/contracts/config/models.json)
- **Whole-Domain Batch Pipeline:** [whole-domain/prepare.ts](../apps/batch/src/whole-domain/prepare.ts), [whole-domain/capacity.ts](../apps/batch/src/whole-domain/capacity.ts), [whole-domain/frames.ts](../apps/batch/src/whole-domain/frames.ts), [whole-domain/finish.ts](../apps/batch/src/whole-domain/finish.ts), [whole-domain/coverage.ts](../apps/batch/src/whole-domain/coverage.ts), [whole-domain/terrain.ts](../apps/batch/src/whole-domain/terrain.ts)
- **Sample Packing, Validation & Publication:** [sample-pack-v5.ts](../apps/batch/src/sample-pack-v5.ts), [forecast/sample-pack.ts](../packages/forecast/src/sample-pack.ts), [parallel.ts](../apps/batch/src/parallel.ts), [build.ts](../apps/batch/src/build.ts), [local-build.ts](../apps/batch/src/local-build.ts), [cli.ts](../apps/batch/src/cli.ts), [validate.ts](../apps/batch/src/validate.ts), [publication.ts](../apps/batch/src/publication.ts), [immutable-upload.ts](../apps/batch/src/immutable-upload.ts), [terrain/sparse.ts](../apps/batch/src/terrain/sparse.ts)
- **Providers, Rendering & Workers:** [provider.ts](../apps/batch/src/provider.ts), [gfs/acquire.ts](../apps/batch/src/indexed-grib/acquire.ts), [icon/acquire.ts](../apps/batch/src/split-grib/acquire.ts), [render.ts](../apps/batch/src/render.ts), [raster.ts](../apps/batch/src/raster.ts), [raster-pool.ts](../apps/batch/src/raster-pool.ts), [raster-worker.ts](../apps/batch/src/raster-worker.ts), [webp.ts](../apps/batch/src/webp.ts), [sampler.ts](../packages/forecast/src/sampler.ts)
- **API & Workflows:** [api/coverage.ts](../apps/api/src/coverage.ts), [api/sample.ts](../apps/api/src/sample.ts), [api/resources.ts](../apps/api/src/resources.ts), [publication-workflow.ts](../scripts/publication-workflow.ts), [operations.ts](../scripts/operations.ts), [forecast.yml](../.github/workflows/forecast.yml), [forecast-model.yml](../.github/workflows/forecast-model.yml)

---

## 3. Milestone 1: Baseline Prerequisites, Critical-Path Instrumentation & Baseline Measurement

### 3.1 Three Mandatory Fixes Before Running the Baseline

The current working tree has three concrete bugs/admission blocks that prevent measuring or serving a real whole-domain baseline. Fix and test all three first:

#### Fix 1 — Admit Real Fine Sparse Coverage in the API (`apps/api/src/coverage.ts:88`)
- **Current Bug:** In [api/coverage.ts](../apps/api/src/coverage.ts#L10), `MAX_API_SPARSE_BYTES` is set to `MAX_COVERAGE_BITSET_BYTES` (`512 KiB`), and line 88 throws `CoverageError('Sparse coverage exceeds serving byte budget')` when `descriptor.files.sparse.bytes > MAX_API_SPARSE_BYTES`. The actual bundled fine `sparse.bin` files are **`4.43 MB` (`4,430,108 B`) for GFS `k=10`** and **`2.93 MB` (`2,930,876 B`) for ICON-EU `k=5`**, so both models immediately fail `/sample` serving!
- **Required Fix:**
  1. Align `MAX_API_SPARSE_BYTES` in [api/coverage.ts](../apps/api/src/coverage.ts#L10) with `MAX_SPARSE_COVERAGE_BYTES` from `@av/contracts` (or a measured serving ceiling `>= 6 * 1024 * 1024` bytes that admits both models with headroom).
  2. Audit the in-flight reservation (`reserveAllocation(descriptor.files.sparse.bytes * 3 + descriptor.files.tiles.bytes + bytes.length * 4)` plus `readBoundedStream`'s `limit * 2` reservation against `MAX_IN_FLIGHT_READ_BYTES = 32 MiB`) and the per-bucket coverage `ByteCache` (`new ByteCache(16, 8 * 1024 * 1024)` at line 71 of [api/coverage.ts](../apps/api/src/coverage.ts#L71)).
  3. Because GFS fine coverage retains `~5.5 MiB` (`blockIds + offsets + output + halo + tiles + layout.indexBytes`) and ICON-EU fine coverage retains `~3.6 MiB`, an `8 MiB` `ByteCache` cannot hold both models' fine coverages simultaneously without evicting on every alternating request! Raise the coverage `ByteCache` capacity in [api/coverage.ts](../apps/api/src/coverage.ts) to **`24 * 1024 * 1024` (`24 MiB`)** (charging coverage directories, masks, layouts, and in-flight loads within the Worker's `128 MB` isolate budget).
  4. Add unit and integration tests in `apps/api/test/coverage.test.ts` and `apps/api/test/worker.test.ts` loading the **actual bundled GFS (`4.43 MB`) and ICON-EU (`2.93 MB`) fine coverage descriptors** concurrently.

#### Fix 2 — Align the 1 MiB Chunk Buffer in `createShardedSamplePackWriter.finish()` (`apps/batch/src/sample-pack-v5.ts:276`)
- **Current Bug:** In [sample-pack-v5.ts](../apps/batch/src/sample-pack-v5.ts#L276), `finish()` allocates its read chunk as:
  ```ts
  const chunk = Buffer.allocUnsafe(Math.min(sectionBytes, (WRITE_CHUNK_BYTES / CELL_BYTES) * CELL_BYTES));
  ```
  Because `WRITE_CHUNK_BYTES = 1024 * 1024` (`1,048,576`) is not divisible by `CELL_BYTES` (`5`), JavaScript float division `(1048576 / 5) * 5` evaluates to `1,048,576` (`1048576 % 5 === 1`), which **splits a 5-byte cell record across the 1 MiB chunk boundary**! Whenever a single channel's `sectionBytes` in a shard exceeds `1 MiB` (`> 209,715` stored cells, which occurs on whole-domain fine shards with `1–4` channels), the inner loop `for (let offset = 0; offset < length; offset += CELL_BYTES)` reads past the misaligned boundary, corrupts cell offsets, and throws `Sample shard channel data exceeds its blocks` / `Sample shard channel data length mismatch`!
- **Required Fix:**
  1. Replace `(WRITE_CHUNK_BYTES / CELL_BYTES) * CELL_BYTES` at line 276 of [sample-pack-v5.ts](../apps/batch/src/sample-pack-v5.ts#L276) with:
     ```ts
     const alignedChunkBytes = Math.floor(WRITE_CHUNK_BYTES / CELL_BYTES) * CELL_BYTES;
     const chunk = Buffer.allocUnsafe(Math.min(sectionBytes, alignedChunkBytes));
     ```
     and assert `sectionBytes % CELL_BYTES === 0 && length % CELL_BYTES === 0` before the inner `offset += CELL_BYTES` loop.
  2. Add a regression test in `packages/forecast/src/sample-pack-v5.test.ts` where a single channel section in a shard exceeds `1 MiB` (`> 210,000` stored cells) and verify exact round-trip decoding.

#### Fix 3 — Admit Raster Workers for Whole-Domain Fine Surfaces (`apps/batch/src/whole-domain/capacity.ts:53`, `apps/batch/src/raster-pool.ts:11`)
- **Current Bug:** In [whole-domain/capacity.ts](../apps/batch/src/whole-domain/capacity.ts#L53):
  ```ts
  const fineFields = fineActive * TERRAIN_COLUMN_METHOD.outputs.length * CELL_BYTES;
  const sharedInputBytes = Math.max(nativeCells * nativeLayers * CELL_BYTES + nativeMaskBytes, fineFields + fineMaskBytes);
  const rasterWorkers = sharedInputBytes <= MAX_RASTER_SHARED_INPUT_BYTES ? rasterWorkerCount() : 0;
  ```
  For GFS `k=10` (`fineFields + fineMaskBytes ≈ 161 MB`) and ICON-EU `k=5` (`fineFields + fineMaskBytes ≈ 106.4 MB`), `sharedInputBytes` exceeds `MAX_RASTER_SHARED_INPUT_BYTES` (`64 MiB` in [raster-pool.ts](../apps/batch/src/raster-pool.ts#L11)), so `admitWholeDomain` silently selects **`rasterWorkers = 0` for both models**!
- **Required Fix:**
  1. Raise `MAX_RASTER_SHARED_INPUT_BYTES` (or add a dedicated `MAX_WHOLE_DOMAIN_RASTER_SHARED_INPUT_BYTES = 256 * 1024 * 1024` in [raster-pool.ts](../apps/batch/src/raster-pool.ts)) and allocate fine `PackedGridField` outputs (`values`, `flags`) and `SparseCoverage` buffers directly on `SharedArrayBuffer`s so `createRasterPool` shares them in-place without duplicating `106–161 MB` on every `renderArchives` call (or explicitly account for `rasterSharedInputs` in `admitWholeDomain` within the `2 GiB` `BUILD_BUDGETS.peakRssBytes` budget).
  2. Add an assertion in `apps/batch/src/capacity.test.ts` verifying `capacity.rasterWorkers > 0` for both `gfs` and `icon-eu` on multi-CPU machines, and a test in `apps/batch/src/raster-pool.test.ts` proving worker threads execute on `PackedGridField` + `SparseCoverageMask`.

### 3.2 Critical-Path Instrumentation (`buildWholeDomainFrames`, `parallel.ts`, `publication-workflow.ts`)
Separate **wall-clock stage intervals (`*WallMs`)** from **overlapping work totals (`*WorkMs`)**:
- In `buildWholeDomainFrames` ([whole-domain/frames.ts](../apps/batch/src/whole-domain/frames.ts)):
  - Record per-frame `acquireWaitWallMs` (wall time the frame loop waited for `acquisition.acquire(hour)`) vs. `acquireTotalWorkMs`,
  - `deriveNativeWallMs` (`deriveFrame`), `deriveFineWallMs` (`prepared.columns.derive`),
  - `packWriteWallMs` (`nativeWriter.writeChannel` + `fineWriter.writeChannel`) and **`packFinishWallMs` (`nativeWriter.finish()` + `fineWriter.finish()` local channel-to-cell transpose at the end of the shard)**,
  - `renderNativeWallMs` and `renderFineWallMs` (broken into `mbtilesWriteWallMs`, `pmtilesConvertWallMs`, `pmtilesVerifyWallMs`), plus cumulative `encodeWorkMs`, `rasterWorkerMs`, `sqliteWorkMs`.
- In `parallel.ts` and `publication-workflow.ts`:
  - Record `planWallMs`, `shardSetupWallMs`, `slowestShardWallMs`, `artifactDownloadWallMs`, `mergePackWallMs`, `finalValidateWallMs`, `r2UploadWallMs`, `casCommitWallMs`, `maintenanceWallMs`, `smokeVerifyWallMs`, plus `process.memoryUsage().rss` and `process.resourceUsage().maxRSS * 1024`.

---

## 4. Milestone 2: Surface-Namespaced `(frameGroup, blockRange)` Sample Packs & Queued API Reads

### 4.1 Surface-Namespaced Two-Dimensional Sample Pack Shards

#### Problem
In `ManifestV5` ([packages/contracts/src/publication.ts](../packages/contracts/src/publication.ts#L130)), GFS publishes two surfaces (`native` for `precip-rate`, `fine` for lift) while ICON-EU publishes one `fine` surface. Under `format: 'cell-major-block-shards-v1'`, all `manifest.frames.length` frames are interleaved inside every cell of `surfaces/<surfaceId>/samples/<shard>.bin`, requiring `finalizeBuild` to call `mergeShardedSamplePacks` ([sample-pack-v5.ts](../apps/batch/src/sample-pack-v5.ts#L319)) on the single `build-publish` runner across all shards.

#### Specification
1. **New Layout Discriminator (`format: 'frame-group-block-shards-v1'`):**
   - Retain `'cell-major-block-shards-v1'` in `surfaceV5Schema`, [validate.ts](../apps/batch/src/validate.ts), [publication.ts](../apps/batch/src/publication.ts), and [api/sample.ts](../apps/api/src/sample.ts) so existing v5 fixtures and retained builds remain valid.
   - Add `'frame-group-block-shards-v1'` where each shard record in `surface.samples.shards` identifies its frame group and block range:
     ```ts
     export const frameGroupShardSchema = z.strictObject({
       group: safeNonnegative,
       firstFrame: safeNonnegative,
       frameCount: safePositive,
       blockShard: safeNonnegative,
       firstBlock: safeNonnegative,
       blockCount: safePositive,
       storedCells: safePositive,
       bytes: safePositive.max(64 * 1024 * 1024),
       key,
       sha256
     });
     ```
2. **Exact Surface-Namespaced Key Validation (`validateV5Records` in `packages/contracts/src/publication.ts`):**
   - Validate `manifest.buildId` with `/^\d{8}T\d{6}Z-[a-f0-9-]{36}$/` ([build.ts](../apps/batch/src/build.ts#L27)).
   - Require exact string equality for each shard key:
     ```ts
     const expectedKey = `builds/${manifest.model}/${manifest.buildId}/surfaces/${surface.id}/samples/g${shard.group}-b${shard.blockShard}.bin`;
     if (shard.key !== expectedKey || keys.has(shard.key)) throw new Error('Invalid sample shard key');
     ```
   - Within `g<group>-b<blockShard>.bin`, each cell stores `groupChannelCount = shard.frameCount * surface.layers.length` channels in `frame-then-layer` order (`5 bytes/cell/channel`), preserving the $16 \times 16$ block core plus duplicated right/bottom interpolation neighbors ($17 \times 17$ normal stored cells).
   - Note that while cross-shard `mergeShardedSamplePacks` is eliminated, `createShardedSamplePackWriter.finish()` inside each shard still transposes its `groupChannelCount` channels (`2–6` frames $\times$ `1–2` layers) into cell-major order (or can write directly into pre-sized in-memory `<= 64 MiB` shard buffers when a group's total surface pack fits in memory!).
3. **Complete 2D Partition Verification per Surface (`validateV5Records` & `assertSampleLayoutBindingV5`):**
   - For each `surface` in `manifest.surfaces`:
     - Verify that distinct `group` indices `0 .. G - 1` partition `[0, manifest.frames.length)` contiguously (`firstFrame === 0` for `group === 0`, `nextGroup.firstFrame === prevGroup.firstFrame + prevGroup.frameCount`, final `firstFrame + frameCount === manifest.frames.length`).
     - Verify that within every `group`, `blockShard` indices `0 .. B_g - 1` partition `[0, surface.samples.blockCount)` contiguously (`firstBlock === 0` for `blockShard === 0`, `next.firstBlock === prev.firstBlock + prev.blockCount`, final `firstBlock + blockCount === surface.samples.blockCount`), with exact `storedCells` and `bytes === storedCells * (frameCount * surface.layers.length) * CELL_BYTES`.

### 4.2 Queued API Binary Reads & Group-Local Channel Planning (`apps/api/src/sample.ts`, `apps/api/src/resources.ts`, `apps/api/src/coverage.ts`)

1. **Decouple `resolveSparseCoverage` Layout Cache from Total Timeline `channelCount` (`apps/api/src/coverage.ts:69`):**
   - Currently, `resolveSparseCoverage` keys its cache by `${hash}/${surface.samples.channelCount}` and calls `prepareShardedSamplePackLayout(mask.grid, coverage.blockIds, surface.samples.channelCount)` assuming a single uniform `channelCount` across the entire timeline.
   - Under `'frame-group-block-shards-v1'`, different frame groups can have different `frameCount`s (e.g., 22 frames split across 4 shards = `[6, 5, 6, 5]` frames!).
   - Cache the decoded `SparseCoverageMask` by `hash` alone in `resolveSparseCoverage`, and compute/cache the lightweight `ShardedSamplePackLayout` per `(hash, groupChannelCount)` (which is only `1–2` distinct `groupChannelCount` values per build!).
2. **Group-Local Channel Indexing in `serveSampleV5` ([api/sample.ts](../apps/api/src/sample.ts)):**
   - For `'frame-group-block-shards-v1'`, group requested `frames` by their owning `group` (`manifestFrameIndex >= shard.firstFrame && manifestFrameIndex < shard.firstFrame + shard.frameCount`).
   - Within each touched `group`, map `(frame, layer)` to `localChannel = (manifestFrameIndex - group.firstFrame) * surface.layers.length + surface.layers.indexOf(layer)` with `groupChannelCount = group.frameCount * surface.layers.length`.
   - Enforce `totalRangeBytes <= MAX_SAMPLE_RANGE_BYTES` across all planned `(surface, group)` reads before issuing any R2 reads.
3. **Bounded FIFO Queue with Coalescing & Deadlines in `MaterializedReads` ([api/resources.ts](../apps/api/src/resources.ts#L43)):**
   - If `key` is already in `this.pending` (with no `deadlineError`) and `this.waiters < this.maxWaiters`, coalesce immediately onto the existing promise.
   - When `this.pending.size >= this.maxPending` (`maxPending = 8`), enqueue the request in a bounded FIFO wait queue (`maxQueued = 64`, `maxWaiters = 96`) governed by `timeoutMs` instead of rejecting immediately. Dequeue the next non-expired waiter in `.finally()` as active reads complete.
   - Cap each individual `/sample` request to `MAX_SAMPLE_CONCURRENT_READS_PER_REQUEST = 4` concurrent `binaryRead` calls so one `frame=all` query (`16` reads across `2 surfaces × 8 groups`) never monopolizes all `8` active slots.

---

## 5. Milestone 3: Complete Lifecycle Migration (`validate → publish → sample → resume → rollback`)

### 5.1 Shared Dependencies (`coverage` & `terrain`) vs. Per-Build Artifacts (`tiles` & `samples`)

1. **`prepare`-Owned Upload & Dependency Receipts (`createBuildPlan` in `apps/batch/src/parallel.ts`):**
   - `prepare` uploads native and fine coverage files (`coverage/<hash>/manifest.json`, `sparse.bin`, `tiles.bin`) via `putImmutable(store, key, bytes, contentType, signal, true)` and verifies all prepared sparse terrain objects (`terrain/prepared/<hash>/manifest.json`, `elevation-<i>.f32`, `valid-<i>.u8`) in R2, recording their `{ key, bytes, sha256, etag }` receipts in `plan.dependencies`.
   - Only `output/plan.json` and `output/coverage/` (`< 8 MiB`) are uploaded to the GitHub Actions plan artifact; shards stage prepared terrain directly from R2 (`terrain/prepared/<hash>/...`) and verify its chunks against `plan.wholeDomain.terrain` via `validateSparsePreparedTerrain`.
2. **Shard-Owned Validation & Direct Upload with Mandatory `customMetadata.sha256` (`buildShard` in `apps/batch/src/parallel.ts`):**
   - Each shard runs `validateArchive` on its `.pmtiles` files and `validateSampleShard` on its `surfaces/<surfaceId>/samples/g<shard>-b<blockShard>.bin` files.
   - Each shard uploads those immutable objects directly to R2 via `putImmutable(store, key, bytes, contentType, signal, true)` (`requireDigestMetadata = true` in [immutable-upload.ts](../apps/batch/src/immutable-upload.ts#L5), which enforces `head.size === bytes.byteLength`, `head.etag === '"' + md5Hex + '"'`, `head.metadata?.sha256 === sha256`, and a 32-byte tail readback).
   - Emit `shards/<shard>/receipt.json` **only after** local validation and `putImmutable(..., true)` complete for all shard outputs.

### 5.2 Migrating Every Lifecycle Consumer (Local-Payload Mode vs. Receipt-Verified Remote Mode)

Review Finding #4 identified five lifecycle entry points that currently assume full-timeline shards and local multi-GB payloads on disk. Update all five together:

| Lifecycle Entry Point | Current Assumption | Required Migration for `'frame-group-block-shards-v1'` & Receipt-Only Finalization |
| :--- | :--- | :--- |
| **1. `validateBuildV5`** ([validate.ts:228](../apps/batch/src/validate.ts#L228)) | Assumes 1D full-timeline shards (`prepareShardedSamplePackLayout(..., surface.samples.channelCount)`) and calls `readLocalFile(localPath(root, shard.key))` on every sample shard and `.pmtiles` file. | Support both `'cell-major-block-shards-v1'` and `'frame-group-block-shards-v1'` (validating each `group` with `group.frameCount * surface.layers.length` channels). When called in local-payload mode (`buildProduct`, `cli.ts validate`, `buildShard`), read and validate local files on disk. When called in distributed finalizer mode with verified shard receipts + `store`, validate the complete 2D receipt partition against `manifest` and verify every remote object in R2 (`head.size`, `head.etag`, `head.metadata?.sha256`). |
| **2. `validateLocalBuild` / CLI `validate`** ([local-build.ts:15](../apps/batch/src/local-build.ts#L15), [cli.ts:74](../apps/batch/src/cli.ts#L74)) | Calls `validateBuild(root, manifest, await loadCoverage(product))` expecting all sample shards, `.pmtiles`, coverage, and terrain chunks on local disk under `root`. | Keep `cli.ts validate --manifest PATH` working for local builds (both `'cell-major-block-shards-v1'` and `'frame-group-block-shards-v1'` plus v3/v4 manifests), and add `--receipts-only` / remote-store support when validating a distributed receipt bundle. |
| **3. `publish` & `publishV5Dependencies`** ([publication.ts:78, 125](../apps/batch/src/publication.ts#L78)) | Calls `stat(localPath(root, file.key))` and `readLocalFile` on every object in `forecastObjectsV5(manifest)` and `surface.terrain`. | If local payload files exist under `root` (local build mode), upload them via `uploadBounded` + `putImmutable(..., true)`. If running from verified shard receipts (`options.receipts` / remote-staged mode), verify every object in `forecastObjectsV5(manifest)` and `plan.dependencies` in R2 via `store.head(key)` asserting `head !== null && head.size === expected.bytes && head.etag === expected.etag && head.metadata?.sha256 === expected.sha256` before uploading `provenance.json`, `manifest.json`, and executing `casPointer`. **Never** bypass missing `head.metadata?.sha256` with `verifyRemoteHash`. |
| **4. `resumePublication` & `assertV5ResumeIdentity`** ([publication-workflow.ts:168, 224](../scripts/publication-workflow.ts#L168)) | `assertV5ResumeIdentity` calls `readLocalFile(localPath(root, shard.key))` for every sample shard (line 206). | Preserve `forecastArtifactRevision` ([publication-workflow.ts:289](../scripts/publication-workflow.ts#L289)) workflow/repo/branch/SHA authority checks. Update `assertV5ResumeIdentity` to accept either local shard files (when `RETAIN_FULL_ARTIFACTS=true`) or verified `shards/*/receipt.json` + remote R2 verification (`head.size`, `head.etag`, `head.metadata?.sha256`, plus `verifyV5Dependencies`) so `resume-run-id` works on receipt-only workflow artifacts! |
| **5. `rollback` & `verifyV5Dependencies`** ([publication.ts:152, 187](../apps/batch/src/publication.ts#L152)) | Line 172 calls `prepareShardedSamplePackLayout(surface.grid, coverage.blockIds, surface.samples.channelCount)` assuming 1D full-timeline shards. | Branch on `surface.samples.format`: for `'frame-group-block-shards-v1'`, validate each frame group's block layout with `groupChannelCount = group.frameCount * surface.layers.length`, then call `verifyRemoteHash(store, shard.key, shard.sha256, shard.bytes, shard.bytes, signal, true)` (`requireMetadata = true`) on every shard. |

### 5.3 Required Old/New Lifecycle Test Matrix
Add an automated test suite in `apps/batch/src/publication.test.ts` and `scripts/publication-workflow.test.ts` exercising the complete chain:
**`validate → publish → sample (single-frame & frame=all) → resumePublication → rollback`**
across all three manifest families:
1. Legacy v3/v4 (`cell-major-blocks-v1`),
2. Full-timeline v5 (`cell-major-block-shards-v1`), and
3. Frame-group v5 (`frame-group-block-shards-v1`, both with local payloads and with receipt-only shard artifacts).

---

## 6. Milestone 4: Target `buildWholeDomainFrames` for Persistent Workers, Direct-to-Ring Prefetch & Memory Accounting

### 6.1 Exact Live Memory Figures from Current Product Configs
Using the current product configurations ([gfs.json](../packages/contracts/config/models.json#L25): `maxVerticalLevels: 21`, `verticalCoordinate: 'isobaric'`, `fieldsPerLevel = 2`; [icon-eu.json](../packages/contracts/config/models.json): `maxVerticalLevels: 30`, `verticalCoordinate: 'model-levels'`, `fieldsPerLevel = 3`) and `admitWholeDomain` in [whole-domain/capacity.ts](../apps/batch/src/whole-domain/capacity.ts#L57):
$$\text{nativeFrameBytes} = \text{nativeActive} \times (7 + \text{fieldsPerLevel} \times \text{maxLevels}) \times 5$$

| Model | `nativeActive` (No-Africa + Donor Support) | `maxLevels` | `fieldsPerLevel` | Bytes per Active Cell | 1 `NormalizedFrame` (`MiB`) | 2-Slot Ring (`current + prefetch`, `MiB`) | Fine `PackedGridField` (`2 layers × 5 B`, `MiB`) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **GFS (`k=10`)** | `~175,681` | `21` | `2` | `245 B` | **`~41.05 MiB`** | **`~82.10 MiB`** | **`~149.25 MiB`** |
| **ICON-EU (`k=5`)** | `~427,255` | `30` | `3` | `485 B` | **`~197.62 MiB`** | **`~395.24 MiB`** | **`~98.70 MiB`** |

### 6.2 Retargeting `buildWholeDomainFrames` ([whole-domain/frames.ts](../apps/batch/src/whole-domain/frames.ts))
Apply all per-frame compute and I/O optimizations directly to `buildWholeDomainFrames` and `admitWholeDomain`:

1. **Direct Field-Level Decoding into a 2-Slot `SharedArrayBuffer` Ring (No Transient 3rd Frame Copy):**
   - Allocate a 2-slot `SharedArrayBuffer` ring (`slot = frameOrdinal & 1`) once in `buildWholeDomainFrames` and pass the target slot's views into `acquisition.acquire(hour, targetSlot)` in [gfs/acquire.ts](../apps/batch/src/indexed-grib/acquire.ts) and [icon/acquire.ts](../apps/batch/src/split-grib/acquire.ts#L456).
   - Scatter decoded GRIB values directly into the target slot's typed arrays using a bounded single-field decoder buffer (`<= 8 MiB`), never constructing a third full `NormalizedFrame` on the heap.
   - Keep at most **one** `acquire()` call in flight at any time.
2. **Immediate Local Abort on Failure Before Draining Prefetch:**
   - In `buildWholeDomainFrames` ([whole-domain/frames.ts](../apps/batch/src/whole-domain/frames.ts#L50)), create a locally owned controller:
     ```ts
     const localController = new AbortController();
     const signal = options.signal ? AbortSignal.any([options.signal, localController.signal]) : localController.signal;
     ```
   - Pass `signal` to `loadWholeDomainTerrain`, `provider.open`, `acquisition.acquire`, `createShardedSamplePackWriter`, `createRenderer`, and worker pools.
   - Attach an immediate `.catch(() => {})` handler when launching `prefetchPromise = acquisition.acquire(hours[i + 1], (i + 1) & 1)`.
   - In `catch (error)`, **call `localController.abort(error)` as the very first statement** so any in-flight `prefetchPromise` immediately aborts its HTTP downloads, retries, and decoder subprocesses.
   - In `finally`, `await Promise.allSettled([prefetchPromise, nativeWriter?.close(), fineWriter?.close(), pool?.close(), acquisition?.close()])` before releasing shared buffers, and rethrow the original first `error`.
   - Add a deterministic test in `apps/batch/src/parallel-refined.test.ts` (or `whole-domain/frames.test.ts`) verifying that a synchronous `derive` error aborts a blocked `acquire(hours[1])` immediately and preserves the `derive` error.
3. **Generation-Tagged Phase Barriers for Persistent Workers in `buildWholeDomainFrames`:**
   - Create a persistent worker pool once per `buildWholeDomainFrames` session (`capacity.rasterWorkers > 0` for both GFS and ICON-EU) backed by `SharedArrayBuffer`s for `terrainData`, `prepared.fine.mask`, `NormalizedFrame` ring slots, `diagnostics`, and the canonical `PackedGridField` outputs (`usable-lift-msl`, `usable-lift-agl`).
   - Tag every worker message with `{ generation: completedFrames, phase: 'derive' | 'render', jobId }` and enforce four barriers per frame:
     1. **Barrier 1 (Native Derive & Diagnostics):** Complete `deriveFrame(frame, workingMask, { ...deriveOptions, layers: product.layers, diagnostics })` before dispatching fine `phase: 'derive'` jobs.
     2. **Barrier 2 (Parallel Quad Derivation):** Partition active native quads across the worker pool into the shared `PackedGridField` (`length = fine.coverage.offsets[fine.coverage.blockIds.length]`, storing 1 canonical cell per active `(row, col)` with worker-local `ReconstructedProfileWorkspace` scratch and zero wire-halo duplication). Await all `phase: 'derive'` jobs for `generation` before starting `pack` or `render`.
     3. **Barrier 3 (Concurrent Read-Only `pack` and `render`):** `fineWriter.writeChannel` and `fineRenderer.renderArchives` read the immutable `PackedGridField` in-place (`0 B` copy into `createRasterPool` when `field.values.buffer instanceof SharedArrayBuffer`). Wire-halo $17 \times 17$ duplication occurs only inside `writeChannel`.
     4. **Barrier 4 (Drained Reset):** Await both `writeChannel` and all `phase: 'render'` worker jobs for `generation` before advancing to `generation + 1`.

---

## 7. Milestone 5: Separable `Float64` Raster Sampling & Gated Promotions (`4 vs. 8` Shards, `k=25`, `z=9–10`)

### 7.1 Preserve `Float64` Separable Sampling & Enable `reduceKnownQuad` on `PackedGridField`
In [sampler.ts](../packages/forecast/src/sampler.ts#L263), `prepareGridSampling` already computes separable 1D `rows` and `columns` using `Float64Array` (`lower`, `upper`, `fraction`).
1. **Preserve Exact `Float64` Arithmetic:**
   - Keep `Float64Array` fractions, `snapGridCoordinate`, `reduceKnownQuad`, and `reduceCells` unchanged.
   - Cache 1D `rows` by `(z, y)` and 1D `columns` by `(z, x)` inside `createRasterizer`, charging their exact bytes in `geometryBytes`.
2. **Enable `reduceKnownQuad` for `PackedGridField`:**
   - In [sampler.ts](../packages/forecast/src/sampler.ts#L293), `if (!('coverage' in field) && fx !== 0 && fy !== 0)` currently skips `reduceKnownQuad` for every `PackedGridField`.
   - Resolve the 4 corner offsets `(a, b, c, d)` in `PackedGridField` once per unique `(rows.lower[y], columns.lower[x])` grid quad (or cache the last `(r0, c0) -> (a, b, c, d)` across the scanline) and invoke `reduceKnownQuad(field, a, b, c, d, fx, fy, spec, out)` for `PackedGridField` whenever `fx !== 0 && fy !== 0`.
3. **Conservative Blank-Tile Detection:**
   - Retain the existing `contributors.some(...)` blank shortcut in [raster.ts](../apps/batch/src/raster.ts#L171) and single `blankEncoded` buffer reuse in [render.ts](../apps/batch/src/render.ts#L72) as baseline.

### 7.2 Separate Measurement-Gated Promotions
1. **`4` vs. `8` Forecast Shards:** Compare `4` vs. `8` shards on full-domain `ICON-EU k=5 / z=8` and `GFS k=10 / z=7` builds, recording runner queue/setup overhead, cold acquisition overhead, `packFinishWallMs`, and `slowestShardWallMs`.
2. **GFS `k=25` and Zoom `9–10`:** Gate GFS `k=25` and each additional native zoom (`z=8` on GFS, `z=9`, `z=10`) behind a dedicated full-build receipt proving peak RSS `<= 2 GiB`, end-to-end duration within `deadlineAt`, R2 storage/object counts, and API `/sample` load compliance.

---

## 8. Ready-to-Ship Checklist

- [ ] **Prerequisite Fixes (Milestone 1):**
  - [ ] [api/coverage.ts](../apps/api/src/coverage.ts#L88) admits the real bundled fine `sparse.bin` files (**`4.43 MB` GFS**, **`2.93 MB` ICON-EU**) with a `24 MiB` coverage `ByteCache` and passing tests on the real descriptors.
  - [ ] [sample-pack-v5.ts](../apps/batch/src/sample-pack-v5.ts#L276) uses `Math.floor(WRITE_CHUNK_BYTES / CELL_BYTES) * CELL_BYTES` (`5-byte` aligned chunks) in `finish()`, verified by a regression test crossing the `1 MiB` channel boundary.
  - [ ] [whole-domain/capacity.ts](../apps/batch/src/whole-domain/capacity.ts#L53) and [raster-pool.ts](../apps/batch/src/raster-pool.ts) admit `rasterWorkers > 0` for both GFS `k=10` and ICON-EU `k=5`, verified by tests proving workers execute on `PackedGridField`.
- [ ] **Baseline & Optimized Full-Domain Receipts (Milestones 1–4):**
  - [ ] Both **baseline** and **final post-optimization** full-domain builds for **ICON-EU `k=5 / z=8`** and **GFS `k=10 / z=7`** are completed on comparable inputs and recorded with full wall-clock stage intervals (`*WallMs`, including `acquireWaitWallMs`, `packFinishWallMs`, `slowestShardWallMs`, `r2UploadWallMs`, `smokeVerifyWallMs`), cumulative work counters (`*WorkMs`), peak RSS (`<= 2 GiB`), and live `/sample` + tile serving verification.
- [ ] **Lifecycle Migration (Milestones 2 & 3):**
  - [ ] `'frame-group-block-shards-v1'` sample shards under `builds/${model}/${buildId}/surfaces/${surfaceId}/samples/g${group}-b${blockShard}.bin` eliminate cross-shard `mergeShardedSamplePacks`; `MaterializedReads` queues and coalesces concurrent requests up to `maxQueued`.
  - [ ] Automated tests pass across **`validate → publish → sample → resumePublication → rollback`** (plus CLI `validate --manifest`) for v3/v4, `'cell-major-block-shards-v1'`, and `'frame-group-block-shards-v1'` (both local-payload and receipt-only modes).
- [ ] **Whole-Domain Worker & Prefetch Lifecycle (Milestone 4):**
  - [ ] `buildWholeDomainFrames` uses the persistent worker pool with generation-tagged phase barriers, direct-to-ring 2-slot `SharedArrayBuffer` decoding, and immediate `localController.abort(error)` on failure before draining prefetch.
- [ ] **Raster Fast-Path & Gated Promotions (Milestone 5):**
  - [ ] [sampler.ts](../packages/forecast/src/sampler.ts) preserves `Float64` fractions and enables `reduceKnownQuad` on `PackedGridField` with zero RGBA pixel drift; `4 vs. 8` shards, `GFS k=25`, and `z=9–10` remain gated on complete build receipts.
- [ ] `pnpm docs:generate`, `pnpm verify`, `pnpm capacity --model gfs`, and `pnpm capacity --model icon-eu` pass on the final commits.
