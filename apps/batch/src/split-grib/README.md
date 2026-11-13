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

[grib.ts](grib.ts) owns one bounded ecCodes process per acquisition session.
[decode.py](decode.py) reads metadata with ecCodes, decompresses bzip2 with Python,
and checks libaec's decoded sample count. Install the pinned runtime with `pnpm tools:eccodes`; see
[setup](../../../../docs/development.md#setup). Reference tests cover
libaec, ecCodes and bzip2 data, malformed inputs, cancellation and process shutdown.
The optional retained DWD fixture check uses `ICON_DWD_PROBE_DIR`.

Session metrics include decoder time, IPC bytes and native peak RSS. Build
admission reserves native scratch and queued input buffers; published peak RSS
includes the decoder process. [grib.ts](grib.ts) owns the workspace allowance.

Admitted template 3.0 has matching grid-relative and Earth-relative wind axes
([NOAA](https://www.cpc.ncep.noaa.gov/products/tools/wgrib2/new_grid_winds.html)).
Scan modes 0 and 64 change sample order while preserving east/north component signs.

See [science](../../../../docs/science.md#input-fields) for midpoint heights and
flux recovery, and [third-party notices](../../../../THIRD_PARTY_NOTICES.txt).
