# Roadmap

These steps build on the local GFS pipeline. Completed evidence and limits live
in [status](status.md).

## Feature sequence

Keep one batch CLI, one private R2 bucket per environment, and one read-only
Worker while evolving the platform into two product shapes sharing a single
model run: **spatial map fields** and **vertical/time point profiles**.

1. **Prove the deployed path and forecast-horizon monitoring.** Publish a real
   build to staging and exercise deployed R2 range reads, cache behavior,
   concurrent publication, rollback, cleanup, and expiry. Monitor `cycleAgeSeconds`,
   `latestValidTime`, and `horizonExhausted` separately from seven-day artifact
   retention (`expiresAt`).
2. **Verify consumer integrations in use.** Exercise the standalone preview and
   downstream consumers (including the optional Windy plugin host) against
   published data, covering point selection, wrapped longitudes, tile failures,
   deep zoom, timestamp synchronization, cancellation, and page/plugin lifecycle.
3. **Add atmospheric point profiles and Skew-T / windgram charts.** Retain
   pressure, height, temperature, moisture, and U/V wind across levels and times
   in bounded compressed spatial profile chunks so a point query reads a single
   column/time bundle rather than one object per variable × level × hour. Share
   build identity and UTC valid time with map layers, starting with nearest
   native cell selection and explicit method labels.
4. **Adopt lossless WebP tiles after full-archive and client verification.**
   Coordinate the tile encoder, PMTiles `TileType.Webp` metadata and validation,
   `image/webp` MIME headers, URL templates, and blank fallback tiles together
   while preserving legacy PNG builds.
5. **Add native-grid convergence, then one regional model (HRRR CONUS or ICON patch).**
   Reuse geometry-aware kinematics with GFS spherical derivatives (`s⁻¹`,
   distinct from vertical climb rate in `m/s`) and below-ground pressure-level
   masking, validated against analytic vector fields and saved cases before
   onboarding the first higher-resolution regional model.
6. **Treat ridge exposure and mountain wave as explicit research work.**
   Start ridge products with DEM slope/aspect and windward exposure rather than
   uncalibrated climb rates. Start wave products with stability, cross-barrier
   flow, shear, and critical-level diagnostics; wave-band position and strength
   require resolved vertical motion or a verified wave solver.
7. **Resolve distribution questions.** Confirm rights for adapted private-source
   code and maintain [third-party notices](../THIRD_PARTY_NOTICES.txt) before
   making open-source licensing claims or distributing a release.
