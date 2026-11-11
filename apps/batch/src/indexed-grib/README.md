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
`r2://upstream/{model}/{date}/{cycleHour}/` with product and hour tokens.
Upload each GRIB file and its `.idx` to the forecast environment bucket as
immutable objects with `sha256` metadata. Put `_ready.json` with `If-None-Match: *`
after both object types are complete for every configured and companion hour.
The [receipt schema](ready.ts) binds their keys, byte lengths, digests and quoted
R2 ETags. Use one index row per GRIB message with increasing byte offsets.

An explicit cycle uses its `_ready.json`. Discovery without a cycle follows
`upstream/{model}/latest.json` and verifies the ready receipt digest. Advance the
pointer with `If-Match` and the current ETag, or `If-None-Match: *` on the first
cycle. After a conflict, read the pointer again and keep the newest cycle.

Planning verifies object metadata and complete inventories and stores the ready
receipt hash in the build plan. Shards verify that receipt, hash the downloaded
index bytes and request bounded GRIB ranges with `If-Match`. The committed
GRIB byte length supplies the last record's end offset.
