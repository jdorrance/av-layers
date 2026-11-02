# Generated reference

Generated from the source files linked below. After editing them, run:

```sh
pnpm docs:generate
```

`pnpm docs:check` rejects stale generated references. No live forecast, storage credentials or network access is required to generate them.

These are the current settings. Published builds include their own methods, units, and legends.

## Batch CLI

Invoke `pnpm exec node --import tsx apps/batch/src/cli.ts COMMAND` with the options below. Each option takes a value. These commands build and validate local forecasts; publication and deployment use the GitHub workflows in [operations](operations.md). See [development](development.md) for working examples.

Source: [command definitions](../apps/batch/src/commands.ts), consumed by [CLI](../apps/batch/src/cli.ts).

- `build`: `--model <string>`, `--out <string>`, `--cycle <string>`, `--cache-dir <string>`.
- `capacity`: `--model <string>`, `--frames <string>`, `--layers <string>`, `--models <string>`, `--native-zoom <string>`, `--cadence-hours <string>`, `--retention-days <string>`.
- `input-proof`: `--cycle <string>`, `--cache-dir <string>`.
- `validate`: `--manifest <string>`.

## Live models

Source: [product registry](../packages/contracts/src/products.ts). Test fixtures are separate.

### GFS (gfs-soaring)

- Public model ID: `gfs`; model family: `gfs`; source configuration: `noaa-gfs-0p25`; domain: `global`.
- Attribution: NOAA GFS · Aviation Forecast Layers.
- Grid: `regular-latlon`; 1440 columns × 721 rows; spherical Earth radius 6371229 m; periodic longitude: true.
- Bounds [west, south, east, north]: `[-180,-55,180,65]`.
- Coverage: `soaring-land-v1`. Land and coastal buffer between 55°S and 65°N; Russia, Greenland and Antarctica excluded.
- Native tile zoom: 0–7.
- Forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]`; interval: 1 hours.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`.
- Publishing freshness: cycle age at most 18 hours; remaining horizon at least 6 hours.

## Scalar quantities and units

Source: [layer definitions](../packages/contracts/src/layers.ts). Interpret values and absence using [the data guide](data.md).

### Precipitation rate (precip-rate)

- Kind: `scalar`; quantity: `precipitation-rate`; units: `mm/h`.
- Vertical reference: `surface`; time support: `interval-mean`.
- Method: `trailing-precipitation-rate-v1`; palette: `rain`.
- Admits physical no-lift status: false; public no-lift value: `null`; admits lift support flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Usable lift depth (model AGL) (usable-lift-agl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m AGL`.
- Vertical reference: `model-AGL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-pbl-1p2-v1`; palette: `lift`.
- Admits physical no-lift status: true; public no-lift value: `0`; admits lift support flags: true.
- Zero on no-lift interpolation: true; hide nonpositive rendered values: true.

### Usable lift top (MSL) (usable-lift-msl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m MSL`.
- Vertical reference: `MSL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-pbl-1p2-v1`; palette: `lift`.
- Admits physical no-lift status: true; public no-lift value: `null`; admits lift support flags: true.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

## Status and support encodings

Public sample statuses: `valid`, `no-usable-lift`, `unavailable`, `outside-domain`.

The packed status and support constants below come from the same [layer definitions](../packages/contracts/src/layers.ts) used by derivation and sampling. Status occupies the low bits; support is a bitwise union. Layer definitions above restrict admissible combinations.

- `STATUS_MASK`: `3`.
- `STATUS_NO_LIFT`: `1`.
- `STATUS_OUTSIDE`: `3`.
- `STATUS_UNAVAILABLE`: `2`.
- `STATUS_VALID`: `0`.
- `SUPPORT_MASK`: `28`.
- `SUPPORT_PARCEL_CROSSING`: `4`.
- `SUPPORT_PBL_CLOSURE`: `16`.
- `SUPPORT_PROFILE_TOP`: `8`.

## Methods and normalized inputs

Source: [method definitions](../packages/contracts/src/methods.ts). The numerical kernel consumes these exact parameter constants. The adapter boundary supplies the declared input units; the column bridge performs its explicit Celsius/hPa conversion. No vector input is currently admitted. See [science](science.md) and [extension guide](extensions.md) for assumptions and future additions.

### dry-lenschow-pbl-1p2-v1

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `pblHeightM`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`.
- Spatial support: `column`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumBisectionIterations`: `60`.
- `maximumProfileGapM`: `1000`.
- `maximumProfileTemperatureC`: `60`.
- `maximumSurfacePressureHpa`: `1100`.
- `maximumSurfaceTemperatureC`: `60`.
- `minimumProfileTemperatureC`: `-120`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumSurfacePressureHpa`: `100`.
- `minimumSurfaceTemperatureC`: `-100`.
- `minimumThermalVelocityMps`: `0`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationRelativeTolerance`: `0.000001`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `sinkRateMps`: `1.2`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- Dry parcel calculation; no moist parcel or cloud treatment.
- Evaluated only for cells in daylight across the trailing flux interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells emit no-lift without column evaluation.
- Interval-mean surface fluxes are paired with the endpoint profile and PBL, and usable lift requires Lenschow updraft velocity to exceed sinkRateMps (and w* above minimumThermalVelocityMps).
- PBL may be missing unless the first resolved profile level is neutral or stable; that branch uses the smaller of its height and the PBL depth.
- A profile without a resolved crossing is capped at its highest usable level and flagged.
- MSL and model-AGL outputs share one column evaluation; model terrain is not a high-resolution terrain correction.

### trailing-precipitation-rate-v1

- Outputs: `precip-rate`.
- Required inputs: `precipitationMmPerHour`.
- Spatial support: `column`.

Parameters:

- `minimumRateMmPerHour`: `0`.
- `minimumSolarElevationDeg`: `-0.833`.

Caveats:

- The adapter supplies liquid-water-equivalent rate for the declared trailing interval, including any accumulation differencing.
- Evaluated only for cells in daylight across the trailing interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells are marked unavailable and skipped.
- Negative, non-finite or explicitly missing rates are unavailable; no temporal interpolation is implied.

### Normalized input vocabulary

- `hgtM`: `geopotential-height`; units `m`; dimensions `level-cell`; vertical reference `MSL at isobaric levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `latentHeatFluxWm2`: `upward-latent-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `pblHeightM`: `boundary-layer-depth`; units `m`; dimensions `cell`; vertical reference `model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `precipitationMmPerHour`: `liquid-water-equivalent-precipitation-rate`; units `mm/h`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `pressureLevelsHpa`: `air-pressure-coordinate`; units `hPa`; dimensions `level`; vertical reference `strictly decreasing isobaric levels`; time support `static`; missingness `all-levels-required`.
- `sensibleHeatFluxWm2`: `upward-sensible-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `specificHumidity2mKgKg`: `specific-humidity`; units `kg/kg`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `surfacePressurePa`: `air-pressure`; units `Pa`; dimensions `cell`; vertical reference `surface`; time support `valid-time`; missingness `explicit-cell-mask`.
- `temp2mK`: `air-temperature`; units `K`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `tempK`: `air-temperature`; units `K`; dimensions `level-cell`; vertical reference `isobaric levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `terrainM`: `geopotential-height`; units `m`; dimensions `cell`; vertical reference `MSL`; time support `static`; missingness `explicit-cell-mask`.

## Resource limits

These are configured limits. [Capacity checks](../apps/batch/src/capacity.ts) owns complete-build checks; [serving budgets](serving-budgets.md) describes API memory and load checks.

Complete-build limits:

- `elapsedMs`: `1200000`.
- `gridCells`: `4000000`.
- `peakRssBytes`: `2147483648`.
- `samplePackBytes`: `268435456`.
- `tiles`: `300000`.

Shared producer/consumer contract limits and storage constants:

- `CELL_BYTES`: `5`.
- `MAX_COVERAGE_BITSET_BYTES`: `524288`.
- `MAX_COVERAGE_DESCRIPTOR_BYTES`: `131072`.
- `MAX_GRID_CELLS`: `4000000`.
- `MAX_MANIFEST_BYTES`: `524288`.
- `MAX_METADATA_JSON_TOKENS`: `8192`.
- `MAX_NATIVE_ZOOM`: `8`.
- `MAX_POINTER_BYTES`: `131072`.
- `MAX_PROVENANCE_BYTES`: `4194304`.
- `MAX_PROVENANCE_JSON_TOKENS`: `262144`.
- `MAX_RETAINED_BUILDS`: `256`.
- `MAX_SAMPLE_RANGE_BYTES`: `262144`.
- `MAX_SAMPLE_VALUES`: `256`.
- `MAX_TILE_BYTES`: `1048576`.
- `RETENTION_DAYS`: `7`.
- `SAMPLE_BLOCK_SIZE`: `16`.

Raster worker limits ([source](../apps/batch/src/raster-pool.ts)):

- `MAX_RASTER_WORKERS`: 3.
- `MAX_RASTER_SHARED_INPUT_BYTES`: 67108864.
- `RASTER_WORKER_RESERVE_BYTES`: 134217728; admission estimate per worker, not an operating-system memory limit.

## API reference

The checked-in [OpenAPI document](reference/openapi.json) is generated by invoking the actual Worker’s `GET /openapi.json` route without R2. The running service exposes the same schema at `/openapi.json`, with its interactive viewer at `/docs`. These route definitions describe structure; retained build descriptors supply available layers, frames, units and methods.

- `GET /docs`.
- `GET /healthz`.
- `GET /openapi.json`.
- `GET /tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp`.
- `GET /v1/catalog`.
- `GET /v1/models/{model}/latest`.
- `GET /v1/models/{model}/runs`.
- `GET /v1/models/{model}/runs/{buildId}`.
- `GET /v1/models/{model}/runs/{buildId}/layers/{layer}/{frame}/tilejson.json`.
- `GET /v1/models/{model}/runs/{buildId}/provenance`.
- `GET /v1/models/{model}/runs/{buildId}/sample`.
- `GET /v1/palettes/{id}.json`.
- `GET /v1/palettes/{id}.svg`.
