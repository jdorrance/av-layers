# Indexed GRIB2 input

Fetches configured `.idx` inventories and GRIB2 byte ranges, verifies source
metadata, and returns normalized isobaric frames.

```sh
pnpm input:proof
pnpm test apps/batch/src/indexed-grib
```

[models.json](../../../../packages/contracts/config/models.json) selects source
URLs, parameter identities, field roles, pressure routing, cycles and windows.
[source.ts](source.ts) validates each configured instance;
[provider.ts](provider.ts) exposes the shared provider boundary.
Optional `auxSurface` and `auxLevels` descriptors select instantaneous diagnostics
in canonical [normalized units](../../../../packages/contracts/src/methods.ts).
Wind components are paired and rotated to Earth coordinates.
`geometric-w-to-omega` uses hydrostatic density from same-level temperature and
specific humidity. Cells without usable humidity use dry density.

[acquire.ts](acquire.ts) owns session cancellation, bounded prefetch and companion
reuse. [transport.ts](transport.ts) verifies inventory selection and cached
bytes; [admission.ts](admission.ts) verifies decoded GRIB metadata.
[intervals.ts](intervals.ts) preserves Float64 cumulative companions and checks
reset-window consistency before shared trailing-window recovery.

Checked-in `fixtures/` retain their actual upstream names and provenance.
See [science](../../../../docs/science.md) for interval calculations.

## Private producer storage

Configure an indexed source template under
`r2://upstream/{model}/{date}/{cycleHour}/` with `{product}` and `{hour}` tokens.
Upload each GRIB file and its `.idx` to the forecast environment bucket with
`sha256` object metadata and `If-None-Match: *`. Use one index row per GRIB
message in byte order. Create `_ready.json` with the same write condition after
all configured and companion hours are complete. [Receipt schema](ready.ts).

Discovery without an explicit cycle reads `upstream/{model}/latest.json`.
Publish the pointer with `If-Match` and the current ETag or `If-None-Match: *`
for the first cycle. On conflict, reread the pointer and keep the newest cycle.
