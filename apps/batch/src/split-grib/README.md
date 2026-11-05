# Split GRIB2 input

Fetches configured single-field `.grib2.bz2` objects and normalizes model-level
columns from pressure, temperature and static half-level heights.

```sh
pnpm input:proof
pnpm test apps/batch/src/split-grib
```

[models.json](../../../../packages/contracts/config/models.json) owns URLs,
parameter identities, field roles, flux signs, selected levels and cycles.
[source.ts](source.ts) validates each instance and derives half-level interfaces.
[acquire.ts](acquire.ts) owns static geometry, companion reuse and cancellation;
[fields.ts](fields.ts) checks source metadata against configured grid geometry.
Optional `auxSurface` and `auxLevels` descriptors select instantaneous diagnostics;
their [normalized fields](../../../../packages/forecast/src/inputs.ts) retain
per-cell missingness. Layer descriptors bind both fixed surfaces.
Configured precipitation accumulations use same-run companions to recover
trailing rates with the shared interval kernel and GRIB packing tolerances.

[grib.ts](grib.ts) decodes GRIB packing and scan direction;
[codec/bzip2.ts](codec/bzip2.ts) and [codec/ccsds.ts](codec/ccsds.ts) retain bounded
pure-TypeScript decoding. Reference tests cover libaec, ecCodes and bzip2 data.
The optional retained DWD fixture check uses `ICON_DWD_PROBE_DIR`.

See [science](../../../../docs/science.md#input-fields) for midpoint heights and
flux recovery, and [third-party notices](../../../../THIRD_PARTY_NOTICES.txt).
