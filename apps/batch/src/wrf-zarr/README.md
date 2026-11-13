# WRF Zarr input

Reads committed `av-wrf` Zarr v3 stores into sparse model-level forecast frames.

```sh
pnpm input:proof --model wrf-armenia-3km --cycle 2026-11-13T00:00:00Z --source-store-dir ../av-wrf/output/forecast-20261113/store
pnpm test apps/batch/src/wrf-zarr
```

[The wire contract](../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json)
owns field names, units and codecs. [ready.ts](ready.ts) admits the cycle, grid,
windows and complete object inventory. Every read verifies its receipt SHA-256;
build plans pin that receipt. [metadata.ts](metadata.ts) checks array layout and
coordinates. [shard.ts](shard.ts) verifies shard indexes and decompresses only
spatial chunks needed by the caller, directly into its frame buffers.

Winds are Earth-relative and omega is Pa/s. [provider.ts](provider.ts) preserves
instantaneous values and averages source fluxes and precipitation rates over each
configured output interval. Any missing contributing interval marks the result
missing. This accepts both hourly and three-hour producer tails.

Private R2 uses the existing source store. `--source-store-dir` reads a local
producer store. An explicit `--cycle` selects its receipt; discovery uses the
producer's `latest.json`. A cycle withheld from latest remains available by its
explicit UTC cycle. See [local development](../../../../docs/development.md).
