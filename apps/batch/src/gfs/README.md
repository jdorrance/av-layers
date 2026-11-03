# NOAA GFS input

Downloads NOAA GFS GRIB2 byte ranges, decodes them, and normalizes units,
missingness masks, and trailing statistical intervals for the
[batch builder](../../README.md).

Verify a single upstream frame from the repository root:

```sh
pnpm input:proof --model gfs --cache-dir .cache/gfs
```

Run offline adapter tests:

```sh
pnpm test apps/batch/src/gfs
```

## Source layout

- [provider.ts](provider.ts): cycle discovery, `input:proof`, and lazy session loader.
- [types.ts](types.ts): acquisition options, frame types, and provenance receipts.
- [acquire.ts](acquire.ts): session lifecycle and hourly frame normalization.
- [fields.ts](fields.ts) & [gfs.json](../../../../packages/contracts/config/gfs.json): GFS field selectors, isobaric levels, and forecast hours.
- [transport.ts](transport.ts): `.idx` inventory parsing, byte-range downloads, disk cache, and retries.
- [load.ts](load.ts): GRIB2 metadata verification and decoding.
- [intervals.ts](intervals.ts): recovers 1-hour trailing means and precipitation rates from 6-hour GFS accumulation buckets.
- `fixtures/`: checked-in GRIB2 excerpts and `.idx` fixtures for unit tests.

See [science](../../../../docs/science.md) for statistical window math and
[`@av/forecast`](../../../../packages/forecast/README.md) for column derivation.
