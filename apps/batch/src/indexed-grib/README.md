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

[acquire.ts](acquire.ts) owns session cancellation, bounded prefetch and companion
reuse. [transport.ts](transport.ts) verifies inventory selection and cached
bytes; [admission.ts](admission.ts) verifies decoded GRIB metadata.
[intervals.ts](intervals.ts) preserves Float64 cumulative companions and checks
reset-window consistency before shared trailing-window recovery.

Checked-in `fixtures/` retain their actual upstream names and provenance.
See [science](../../../../docs/science.md) for interval calculations.
