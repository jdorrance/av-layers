# DWD ICON-EU input

Downloads DWD's regridded 0.0625° regular latitude/longitude ICON-EU `.grib2.bz2`
files, decompresses and decodes them in pure TypeScript, and normalizes
model-level columns for the [batch builder](../../README.md).

Verify a single upstream frame from the repository root:

```sh
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
```

## Offline checks

```sh
pnpm test apps/batch/src/icon
```

Runs offline against synthetic and reference GRIB2 payloads (including `libaec`
1.1.3 CCSDS DRT 5.42, `ecCodes` 2.50.0 zero-bit 5.0/5.42, and `bzip2` fixtures).

To run the optional check against a retained 6-field DWD probe directory:

```sh
ICON_DWD_PROBE_DIR=/path/to/icon-probe pnpm test apps/batch/src/icon/icon.test.ts
```

## Source layout

- [provider.ts](provider.ts): cycle discovery, `input:proof`, and lazy session loader.
- [acquire.ts](acquire.ts): session lifecycle, cached static `HSURF`/`HHL` geometry, and hourly flux de-averaging (`ASHFL_S`, `ALHFL_S`).
- [fields.ts](fields.ts) & [icon-eu.json](../../../../packages/contracts/config/icon-eu.json): DWD URLs, GRIB2 discipline/category/number selectors, model levels (`45..74`), and metadata verification.
- [grib.ts](grib.ts), [codec/bzip2.ts](codec/bzip2.ts), [codec/ccsds.ts](codec/ccsds.ts): pure-TypeScript `bzip2` decompression, CCSDS 121.0-B-2 (`DRT 5.42`) decoding, and South-to-North (`+j`) to North-to-South (`-j`) row reordering.
- [discover.ts](discover.ts) & [prove.ts](prove.ts): upstream cycle discovery and single-frame input proof.

See [science](../../../../docs/science.md#input-fields) for midpoint height and
flux equations, and [THIRD_PARTY_NOTICES.txt](../../../../THIRD_PARTY_NOTICES.txt)
for DWD attribution.
