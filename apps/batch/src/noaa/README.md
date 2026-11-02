# NOAA GFS input

Downloads the GFS fields used by the batch job, decodes the GRIB records, and
converts them into arrays with consistent units and missing-data flags.
Downloaded records are cached for reuse.

This is part of [the batch app](../../README.md), not a separate package.
Run its tests from the repository root after `pnpm install`:

```sh
pnpm test apps/batch/src/noaa
```

The tests use small checked-in files. To download a real forecast, follow
[the GFS setup guide](../../../../docs/development.md#build-a-real-gfs-forecast).

Useful files:

- [index.ts](index.ts): public download functions and session setup.
- [fields.ts](fields.ts): which GFS fields to request.
- [GFS settings](../../../../packages/contracts/config/gfs.json): source products, pressure levels, and forecast hours.
- [transport.ts](transport.ts): downloads, caching, and retries.
- [load.ts](load.ts): record checks and decoding.
- [intervals.ts](intervals.ts): converts averages into the required time windows.
- `fixtures/`: small GRIB files used by tests.

A download session must be closed when finished so pending work and decoder
workers are stopped. Forecast calculations live in
[forecast](../../../../packages/forecast/README.md).
