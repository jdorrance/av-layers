# External forecast preparation

Prepare the existing forecast pipeline to accept indexed GRIB2 from a private
R2 producer. The acceptance tests use synthetic WRF and UPP fixtures for
Armenia and New Zealand. Production continues to publish the configured GFS,
ICON-EU, and RRFS models during this work.

Use the [architecture](architecture.md), [extension guide](extensions.md),
[operations runbook](operations.md), and [serving budgets](serving-budgets.md).
Run `pnpm docs:generate` after changing documented configuration or schemas
and `pnpm verify` before landing each phase on `main`.

## Scope

- The external producer integrates the atmosphere, runs UPP, uploads GRIB2 and
  indexes, commits a ready receipt, and signals GitHub. The existing batch
  builder owns terrain refinement, soaring calculations, sample packs, and tiles.
- Use the same v5 native and fine surfaces for 3 km and 1 km inputs. A
  subdivision factor of one keeps their grid geometry equal. The fine surface
  still uses DEM elevation and its own method and packed layer set.
- Keep the z10 raster limit. Current clients overscale these tiles. The dense
  coverage bitset for z11 exceeds the existing 512 KiB read cap.
- Keep browser model choices in the generated contract and API catalog.
  Keep the model registry and acquisition adapters in server code.
- Finish the [v5 cutover](hardening-plan.md#gate-reader-removal-on-retention-and-recoverability)
  and verify all three production models before merging this stack. Build a
  WRF container and register a live domain after the six preparation changes.

## 1. Model configuration

Move each forecast window into the model registry. Derive the lead hours,
rendered horizon, minimum horizon, and shard count from it. Preserve existing
resolved settings and recipe source identities. Store tier as model metadata.

Require a declared expected run count for event-driven models and use it for
retention estimates. Scheduled models derive that count from their UTC cron
entries. Scheduled and manual `all` forecast runs select scheduled models.
Explicit forecast selection and health checks can include event-driven models.

## 2. Hosted handoff and external dispatch

Give staging and production separate sealing keys. The plan job signs
short-lived R2 credentials and seals them with a fresh nonce, binding the
environment bucket, model, build, and deadline. Shard jobs obtain their scoped
credentials from the small current-run bootstrap artifact. The bootstrap
includes the plan and coverage files. The 16 KiB cap applies to the sealed
envelope.

Store the immutable plan and completed shard receipts under the build's
`_control/` prefix. The publisher verifies these receipts directly from R2.
Retain the compact recovery artifact and the existing build expiry rules.
Verify the real staging handoff with the new key before checking production
publication on the merged revision.

Accept an `upstream-cycle-ready` event for one registered event-driven model,
a valid environment, and an explicit UTC cycle. Validate the payload before
it reaches workflow inputs or concurrency groups.

## 3. Private source transport

Use canonical, model-scoped keys in private R2. Validate the bounded
per-cycle ready receipt and bind its identity into the build plan. Require
each configured hour and any interval companion. Verify index hashes and
whole-object identity, bind range reads to the admitted ETag, and bound the
last record with the verified object size. Include the frozen identity in
local cache reuse. Preserve the current HTTP transport.

A producer commits the immutable cycle receipt after its inputs, then
advances the model's latest pointer with a conditional write. An explicit
cycle uses its own receipt. Test missing inputs, corrupt hashes, out-of-range
records, changed objects, and cross-model access.

## 4. Lambert admission

Bind encoded radius, grid spacing, dimensions, LaD, standard parallels, and
producer identity to the configured grid. Verify northern and southern cones
and accept first-cell rounding within the physical GRIB2 precision bound.
Use PROJ control points and wind rotation on each side of the central meridian.

NOAA UPP can emit Earth shape 6 with a radius of 6,371,229 m and LaD equal to
the first true latitude. An explicit 6,370,000 m sphere is also testable when
encoded with that radius. Verify the actual producer output before registering
a real grid. A full New Zealand domain that crosses the antimeridian needs
admitted wrapped coverage or coverage clipped to the existing bounds contract.

Test a 1 km factor-one build through the v5 writer and serving path. Compare
serial and sharded numeric records and decoded tiles where pack layouts differ.
Check that terrain-based lift uses the fine DEM.

## 5. Catalog and automatic selection

Add domain bounds, tier, and nominal grid spacing to the catalog and the
browser-safe model options. Add opt-in Auto in Preview and Windy. Keep explicit
model selection, existing defaults, and pinned URLs.

Use bounds to shortlist available builds, then check expiry, requested time,
and actual coverage. Prefer the finest compatible grid and use deterministic
tie-breaking. Preserve the requested time when falling back to another model.
Test movement between domains, unavailable coverage, shorter forecast
horizons, and older API responses.

## 6. Producer fixture and acceptance

Generate deterministic UPP-style GRIB2, indexes, and ready receipts for tiny
Lambert fixtures in both hemispheres. Use a test-only product registry.
Exercise private source admission, scoped shard reads, assembly, publication,
and a local Worker. Verify catalog, tile, point, and profile responses,
including Earth-relative winds and vertical-velocity conversion.

Document the producer's exact field, grid, interval, object, and dispatch
contract in the [extension guide](extensions.md). Keep raw NetCDF, nested
public manifests, new science layers, and live WRF operations outside this
preparation.
