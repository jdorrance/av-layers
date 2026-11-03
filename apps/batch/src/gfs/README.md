# NOAA GFS input

Downloads the GFS fields used by the batch job, decodes the GRIB records, and
converts them into arrays with consistent units and missing-data flags.
Downloaded records are cached for reuse.

Run from the repository root after [setup](../../../../docs/development.md#setup):

```sh
pnpm input:proof --model gfs --cache-dir .cache/gfs
```

This downloads and checks one input frame, then prints a JSON report. To build
the forecast and view it locally, follow
[the setup guide](../../../../docs/development.md#build-a-real-forecast).

Run the adapter tests with:

```sh
pnpm test apps/batch/src/gfs
```

The tests use small checked-in files and do not download weather data.

## Source layout

- [provider.ts](provider.ts): discovery, input proof, and acquisition entry points
  used by the shared builder. Downloads and decoders load only when needed.
- [types.ts](types.ts): download options, frame types, and input receipts.
- [acquire.ts](acquire.ts): acquisition sessions and hourly normalization.
- [fields.ts](fields.ts): which GFS fields to request.
- [GFS settings](../../../../packages/contracts/config/gfs.json): source products, pressure levels, and forecast hours.
- [transport.ts](transport.ts): downloads, caching, and retries.
- [load.ts](load.ts): record checks and decoding.
- [intervals.ts](intervals.ts): converts averages into the required time windows.
- `fixtures/`: small GRIB files used by tests.

Acquire frames sequentially within a session and close it in `finally` to stop
pending work and decoder workers. The [batch builder](../../README.md) handles
this when running the CLI.

[Science](../../../../docs/science.md) explains input checks and statistical
windows. Forecast calculations live in
[forecast](../../../../packages/forecast/README.md).
