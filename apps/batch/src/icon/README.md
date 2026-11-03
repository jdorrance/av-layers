# DWD ICON-EU input

Downloads DWD's regular latitude/longitude ICON-EU fields and converts them to
model-level columns for the [batch builder](../../README.md).

Run from the repository root after [setup](../../../../docs/development.md#setup):

```sh
pnpm input:proof --model icon-eu --cache-dir .cache/icon-eu
```

This downloads and checks one frame, then prints its input report. Use
`pnpm forecast --model icon-eu --out output --cache-dir .cache/icon-eu` to build
the lift tiles and point data. Both commands reuse downloaded files; see
[development](../../../../docs/development.md#build-a-real-forecast) for cycle
selection and local preview.

## Offline checks

```sh
pnpm test apps/batch/src/icon
```

The default suite runs without network access. Synthetic GRIB messages exercise
packing, row order, missingness, statistical metadata and acquisition.
The CCSDS test includes a nonconstant libaec 1.1.3 reference payload and its
encoding options. The bzip2 fixture is generated independently by Python's
standard library; neither reference library is required to run tests.

If you have the retained 2026-10-08 00Z Skyjuice ICON probe, run this additional
check. It reads six fields, verifies their bytes against `manifest.json`, and
compares one sampled cell with retained reference values:

```sh
ICON_DWD_PROBE_DIR=/path/to/icon-probe pnpm test apps/batch/src/icon/icon.test.ts
```

Without `ICON_DWD_PROBE_DIR`, this check is skipped. A supplied missing or
incomplete directory fails. The probe's manifest records source URLs, digests,
and attribution; the weather files are not committed here.

## Source layout

- [provider.ts](provider.ts): discovery, input proof, and acquisition entry points
  used by the shared builder. Downloads and decoders load only when needed.
- [acquire.ts](acquire.ts): acquisition options, sessions, cached geometry, and
  hourly normalization. Acquire frames sequentially and close the session in
  `finally` to cancel pending downloads and release its caches. Closing waits for
  active acquisition to finish; a closed session cannot acquire another frame.
- [fields.ts](fields.ts): field selection, URLs, and metadata checks.
- [ICON-EU settings](../../../../packages/contracts/config/icon-eu.json): grid,
  levels, and forecast schedule.
- [grib.ts](grib.ts): decoding and north-to-south row ordering. The private
  [bzip2](codec/bzip2.ts) and [CCSDS 5.42](codec/ccsds.ts) codecs handle formats
  unsupported by the pinned `@azohra/meteo.grib` decoder; other packing and GRIB
  section parsing use that library.
- [discover.ts](discover.ts) and [prove.ts](prove.ts): run discovery and input checks.

[Science](../../../../docs/science.md#input-fields) explains model-level heights,
pressures, and flux conversion. Source adaptations and dependency notices are in
[THIRD_PARTY_NOTICES](../../../../THIRD_PARTY_NOTICES.txt).
