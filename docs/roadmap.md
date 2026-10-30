# Roadmap

These steps build on the local GFS pipeline. Completed evidence and limits live
in [status](status.md).

1. **Verify remote operation.** Publish a real build to staging and exercise
   deployed R2 range reads, cache behavior, concurrent publication, rollback,
   cleanup and expiry. Record the observations before production deployment.
2. **Verify the clients in use.** Exercise the standalone preview and downstream
   consumers (including the optional Windy plugin host) with published data,
   covering point selection, tile failures, deep zoom, timestamp changes,
   cancellation and page/plugin lifecycle.
3. **Add regional products.** After verifying the GFS release path, integrate
   HRRR CONUS and the selected ICON-Armenia patch with regional coverage and
   the build/serving contracts.
   Preserve each source's supported times and intervals. New Zealand continues
   to use GFS while regional source access and reuse rights remain unresolved.
4. **Measure operating costs and performance.** Record acquisition, build,
   storage and request costs alongside cold and warm delivery measurements.
   Use those results to choose cadence and extent.
5. **Resolve distribution questions.** Confirm rights for inherited code and
   maintain [third-party notices](../THIRD_PARTY_NOTICES.txt) before making
   licensing claims or distributing a release.

Keep the current batch, private storage and read-only Worker arrangement while
closing these gaps. Introduce another component only when measured requirements
justify its ongoing cost.
