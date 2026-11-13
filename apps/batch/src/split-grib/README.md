# Split GRIB2 input

Fetches configured single-field GRIB2 objects and normalizes model-level
columns from pressure, temperature and static half-level heights.

```sh
pnpm input:proof
pnpm test apps/batch/src/split-grib
```

[models.json](../../../../packages/contracts/config/models.json) owns URLs,
parameter identities, field roles, flux signs, selected levels and cycles.
[source.ts](source.ts) validates each instance and derives half-level interfaces.
[acquire.ts](acquire.ts) owns static geometry, companion reuse and cancellation;
[fields.ts](fields.ts) checks source parameters, levels and statistical windows.
Optional `auxSurface` and `auxLevels` descriptors select instantaneous diagnostics;
their [normalized fields](../../../../packages/forecast/src/inputs.ts) retain
per-cell missingness. Layer descriptors bind both fixed surfaces.
Configured precipitation accumulations use same-run companions to recover
trailing rates with the shared interval kernel and GRIB packing tolerances.

[grib.ts](grib.ts) validates grid identity and decodes GRIB packing;
[codec/bzip2.ts](codec/bzip2.ts) and [codec/ccsds.ts](codec/ccsds.ts) retain bounded
pure-TypeScript decoding. Reference tests cover libaec, ecCodes and bzip2 data.
The optional retained DWD fixture check uses `ICON_DWD_PROBE_DIR`.

ICON-EU reads DWD's native triangular mesh through the v1 URLs in the source
configuration. DWD requires migration by **30 November 2026** and ends the
legacy regular-grid feed afterward ([announcement](https://www.dwd.de/DE/leistungen/opendata/neuigkeiten/opendata_september2026_1.html)).
Native objects use template 3.101 and CCSDS packing without bzip2.

[native-grid.ts](native-grid.ts) maps active output cells to the nearest native
cell on the sphere. A session reads `CLAT` and `CLON` once, validates the configured
mesh identity, then reuses one donor per output column across terrain, half-level
heights, weather and statistical companions. Unmapped cells fail acquisition.
Frame receipts retain coordinate object hashes, mesh identity and the donor-map
hash. [Capacity admission](../whole-domain/capacity.ts) includes the retained map.

The regular output grid, coverage and terrain subdivision remain configured in
`models.json`. Nearest-cell columns preserve native values; they differ from
DWD's former field-specific regular-grid interpolation
([DWD interpolation guide](https://www.dwd.de/DE/leistungen/opendata/help/modelle/Opendata_cdo_EN.pdf?__blob=publicationFile&v=3)).
Native U/V are Earth-relative. Regular-grid fixture decoding retains scan modes
0 and 64 with east/north wind components.

See [science](../../../../docs/science.md#input-fields) for midpoint heights and
flux recovery, and [third-party notices](../../../../THIRD_PARTY_NOTICES.txt).
