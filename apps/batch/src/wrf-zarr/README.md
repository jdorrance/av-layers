# WRF Zarr input

Reads committed `av-wrf` Zarr v3 stores into sparse model-level forecast frames.
Each [product configuration](../../../../packages/contracts/config/models.json)
owns its source model ID, grid, coverage and forecast window. The public catalog
ID is independent of the producer's storage identity.

```sh
pnpm input:proof --model av-wrf --cycle 2026-11-13T00:00:00Z --source-store-dir ../av-wrf/output/forecast-20261113/store
pnpm test apps/batch/src/wrf-zarr
```

[The wire contract](../../../../packages/contracts/schemas/wrf-zarr-v3.schema.json)
owns field names, units and codecs. [ready.ts](ready.ts) admits the cycle, grid,
windows and complete object inventory. Every read verifies its receipt SHA-256;
build plans pin that receipt. [metadata.ts](metadata.ts) checks array layout and
coordinates. [Zarrita](https://github.com/manzt/zarrita.js) reads the Zarr shards
and float32 chunks; [codec.ts](codec.ts) supplies bounded native Zstd.
[shard.ts](shard.ts) checks producer ranges and copies selected cells into caller
buffers, one spatial chunk at a time. It verifies index CRC32C with the AWS SDK
because [Zarrita's codec](https://github.com/manzt/zarrita.js/blob/main/packages/zarrita/src/codecs/crc32c.ts)
only strips the checksum trailer.

Winds are Earth-relative and omega is Pa/s. [provider.ts](provider.ts) preserves
instantaneous values and averages source fluxes and precipitation rates over each
configured output interval. Any missing contributing interval marks the result
missing. This accepts both hourly and three-hour producer tails.

Private R2 uses the existing source store. `--source-store-dir` reads a local
producer store. An explicit `--cycle` selects its receipt; discovery uses the
producer's `latest.json`. A cycle withheld from latest remains available by its
explicit UTC cycle. See [local development](../../../../docs/development.md).

After publishing a cycle to shared R2 and merging the adapter into `main`, start
the hosted staging build with the receipt's `publish_origin_utc`:

```sh
gh workflow run Forecast --ref main -f model=av-wrf \
  -f cycle=2026-11-13T00:00:00Z -f environment=staging
```

Automation uses the [GitHub dispatch envelope](../../../../docs/extensions.md#publish-an-external-cycle).
`av-wrf reconcile` sends a `ReadyReceipt` webhook; connecting it requires a
receiver that creates this envelope.
