# Project status

[Home](../README.md) · [Roadmap](roadmap.md) · [Execution record](foundation-execution.md)

The foundation implementation is undergoing final qualification. GFS remains
the only production-admitted model, with the existing lift and precipitation
quantities. Lambert and varied-capability products are explicitly synthetic
fixtures; no regional model, profile product or new physics is enabled.

## Verified local evidence

The refreshed baseline is `1d78d1c7f9af4a446d2c5d3d6585c9cde6224c85`, including
native zoom 7. Against pinned real GFS inputs from `2026-10-30T00:00:00Z`, the
first complete candidate preserves every one of 43,835,520 numeric sample bytes,
all eight source-frame receipts (excluding capture time), and every decoded and
encoded tile payload at all 97,032 addresses. Archive hashes also match.

That initial run took 18.81 minutes versus 29.21 minutes for the frozen baseline;
peak RSS was 1,167,376,384 versus 1,265,385,472 bytes. This is one observed pair,
not the final controlled repeated-run qualification. Larger theoretical buffer
savings are not presented as measured RSS reductions.

Other local evidence includes regular/Lambert full-pipeline fixtures, interrupted
and ambiguous publication tests, actual workerd overlapping-read cancellation,
repeatable offline seeding, desktop/mobile-layout preview checks, keyboard
controls, request aborts, tile-error recovery and expiry behavior. A mobile
viewport does not establish physical-device behavior. See the
[execution record](foundation-execution.md) for methods and limits.

## Release gates still open

The matching v3 Worker/data/client set, remote lifecycle drills, controlled
warm/uncached load, actual Windy host and two consecutive
scheduled production publications require their final receipts. Until those
exist, F11–F13 are not marked complete. Physical-device validation was explicitly deferred by the user on 2026-11-01. An earlier healthy Worker or a smoke
failure against an unavailable catalog does not establish this release.

## Historical evidence

The [2026-10-30 local receipt](evidence/gfs-local-2026-10-30.json) describes an
older zoom-5/PNG-era checkpoint. Its timings, file formats and counts are
historical and are not current platform limits. Current artifacts use manifest
v3, one cell-major numeric pack and lossless WebP PMTiles.

The supplied plan identifies windgrams and skyjuice as first-party sources;
referenced authorship was checked and [notices](../THIRD_PARTY_NOTICES.txt) retain
that provenance and applicable third-party/data obligations. Live HRRR, ICON,
WRF, profiles, convergence, ridge and wave work remains [deferred](roadmap.md).
