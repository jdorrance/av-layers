# Generated reference

Generated from the source files linked below. After editing them, run:

```sh
pnpm docs:generate
```

`pnpm docs:check` verifies that generated files and Markdown links are up to date.

## Batch CLI

Invoke `pnpm exec node --import tsx apps/batch/src/cli.ts COMMAND` with the options below. See [development](development.md) for local usage and [operations](operations.md) for GitHub workflows.

Source: [command definitions](../apps/batch/src/commands.ts), consumed by [CLI](../apps/batch/src/cli.ts).

- `build`: `--model <string>`, `--out <string>`, `--cycle <string>`, `--cache-dir <string>`, `--terrain-ref <string>`, `--terrain-catalog-ref <string>`, `--terrain-store-dir <string>`.
- `capacity`: `--model <string>`, `--frames <string>`, `--layers <string>`, `--models <string>`, `--native-zoom <string>`, `--cadence-hours <string>`, `--retention-days <string>`.
- `input-proof`: `--model <string>`, `--cycle <string>`, `--cache-dir <string>`.
- `validate`: `--manifest <string>`, `--receipts-only`.

## Terrain CLI

Run `pnpm terrain COMMAND`. `--out` is required. See the [terrain guide](../apps/batch/src/terrain/README.md).

Source: [terrain commands](../apps/batch/src/terrain/cli.ts).

- `inventory`: `--store-dir <string>`, `--out <string>`.
- `sync`: `--store-dir <string>`, `--out <string>`, `--inventory <string>`, `--shard <string>`, `--shards <string>`, `--concurrency <string>`.
- `finalize`: `--store-dir <string>`, `--out <string>`, `--inventory <string>`.
- `prepare`: `--store-dir <string>`, `--out <string>`, `--catalog-ref <string>`, `--grid <string>`.
- `prepare-model`: `--store-dir <string>`, `--out <string>`, `--catalog-ref <string>`, `--model <string>`, `--source-cache-dir <string>`.
- `stage`: `--store-dir <string>`, `--out <string>`, `--prepared-ref <string>`, `--grid <string>`.
- `inspect`: `--store-dir <string>`, `--out <string>`, `--catalog-ref <string>`, `--bounds <string>`.

Terrain reader limits ([source](../apps/batch/src/terrain/reader.ts)):

- `maxCachedPixels`: `8000000`.
- `maxDecodedPixels`: `64000000`.
- `maxOpenTiles`: `8`.
- `maxOutputPixels`: `4000000`.
- `maxRangeBytes`: `8388608`.
- `maxReadBytes`: `268435456`.

## Refinement grids

Run `pnpm refinement --model MODEL` to inspect the configured grids. See [refinement](../apps/batch/src/refinement/README.md).

- `--model <string>`.
- `--zones <string>`.

## Configured models

Sources: [model settings](../packages/contracts/config/models.json) and [forecast windows](../packages/contracts/src/forecast-windows.ts). See [deployments](status.md) for live applications and runs.

Forecast trigger budget: 20 shard jobs; default workers 3.

### GFS (gfs-soaring)

- Public model ID: `gfs`; model family: `gfs`; source configuration: `noaa-gfs-0p25`; domain: `global`.
- Attribution: NOAA GFS · Aviation Forecast Layers.
- Grid: `regular-latlon`; 1440 columns × 721 rows; spherical Earth radius 6371229 m; periodic longitude: true.
- Terrain subdivision factor: `10`; fine grid: 14400 columns × 7201 rows.
- Bounds [west, south, east, north]: `[-180,-55,180,65]`.
- Coverage: `soaring-land-v1`. Land and coastal buffer between 55°S and 65°N; Russia, China, Greenland, Antarctica and Africa excluded.
- Native tile zoom: 0–9.
- Execution: 20 target shards; at most 20 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["25 0,6,12,18 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69,72]`; interval: 1 hours; frame policy: `all-hours`.
- Map prefix ends at forecast hour 72; native samples and profiles retain the full selected axis.
- Source interval changes at hour 123 to 3 hours.
- Vertical coordinate: `isobaric`; maximum levels: 21.
- Calculation methods: `supported-terrain-column-1p2-v2`, `trailing-precipitation-rate-v2`, `native-soaring-v1`, `native-cloud-v1`, `native-surface-v1`, `native-wind-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `nativeCloudSupport`, `precipitationMmPerHour`, `pblHeightM`, `spfhKgKg`, `rhPercent`, `mslpPa`, `capeJkg`, `cloudTotalPct`, `cloudLowPct`, `uWindMps`, `vWindMps`, `u10mMps`, `v10mMps`, `gust10mMps`.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`, `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`, `sensible-heat-flux`, `latent-heat-flux`, `surface-lcl-msl`, `cape-jkg`, `cloud-cover-total`, `cloud-cover-low`, `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`, `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`, `bl-mean-wind-v`.
- Publication timing: cycle age at most 18 hours; remaining horizon at least 48 hours.

### ICON-EU (icon-eu-soaring)

- Public model ID: `icon-eu`; model family: `icon`; source configuration: `dwd-icon-eu-regular-0p0625`; domain: `europe`.
- Attribution: DWD ICON-EU (CC BY 4.0) · Aviation Forecast Layers.
- Grid: `regular-latlon`; 1377 columns × 657 rows; spherical Earth radius 6371229 m; periodic longitude: false.
- Terrain subdivision factor: `5`; fine grid: 6881 columns × 3281 rows.
- Bounds [west, south, east, north]: `[-23.5,29.5,62.5,70.5]`.
- Coverage: `icon-eu-land-v1`. Land and 50 km coastal buffer across the DWD ICON-EU regridded regular-lat-lon domain (23.5°W–62.5°E, 29.5°N–70.5°N); Russia, China, Greenland, Antarctica and Africa excluded.
- Native tile zoom: 0–10.
- Execution: 40 target shards; at most 20 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["20 5,11,17,23 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69,72]`; interval: 1 hours; frame policy: `all-hours`.
- Map prefix ends at forecast hour 72; native samples and profiles retain the full selected axis.
- Vertical coordinate: `model-levels`; maximum levels: 30.
- Calculation methods: `supported-terrain-column-1p2-model-levels-v2`, `trailing-precipitation-rate-v2`, `native-soaring-model-levels-v1`, `native-cloud-model-levels-v1`, `native-surface-model-levels-v1`, `native-wind-model-levels-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressurePa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `nativeCloudSupport`, `precipitationMmPerHour`, `pblHeightM`, `spfhKgKg`, `rhPercent`, `mslpPa`, `capeJkg`, `cloudTotalPct`, `cloudLowPct`, `uWindMps`, `vWindMps`, `u10mMps`, `v10mMps`, `gust10mMps`.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`, `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`, `sensible-heat-flux`, `latent-heat-flux`, `surface-lcl-msl`, `cape-jkg`, `cloud-cover-total`, `cloud-cover-low`, `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`, `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`, `bl-mean-wind-v`.
- Publication timing: cycle age at most 18 hours; remaining horizon at least 48 hours.

### RRFS (CONUS) (rrfs-conus-soaring)

- Public model ID: `rrfs`; model family: `rrfs`; source configuration: `noaa-rrfs-conus-3km`; domain: `conus`.
- Attribution: NOAA RRFS · Aviation Forecast Layers.
- Grid: `lambert-conformal`; 1799 columns × 1059 rows; spherical Earth radius 6371229 m; periodic longitude: false.
- Terrain subdivision factor: `2`; fine grid: 3597 columns × 2117 rows.
- Bounds [west, south, east, north]: `[-134.121428,21.122192,-60.891244,52.628704]`.
- Coverage: `rrfs-conus-land-v1`. Land and 50 km coastal buffer within the operational 3 km CONUS Lambert grid, including adjacent Canadian and Mexican coverage.
- Native tile zoom: 0–10.
- Execution: 40 target shards; at most 20 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["45 3,9,15,21 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24,27,30,33,36,39,42,45,48,51,54,57,60,63,66,69,72]`; interval: 1 hours; frame policy: `all-hours`.
- Map prefix ends at forecast hour 72; native samples and profiles retain the full selected axis.
- Vertical coordinate: `isobaric`; maximum levels: 25.
- Calculation methods: `supported-terrain-column-1p2-v2`, `trailing-precipitation-rate-v2`, `native-soaring-v1`, `native-cloud-v1`, `native-surface-v1`, `native-wind-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `nativeCloudSupport`, `precipitationMmPerHour`, `pblHeightM`, `spfhKgKg`, `rhPercent`, `mslpPa`, `capeJkg`, `cloudTotalPct`, `cloudLowPct`, `uWindMps`, `vWindMps`, `u10mMps`, `v10mMps`, `gust10mMps`.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`, `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`, `sensible-heat-flux`, `latent-heat-flux`, `surface-lcl-msl`, `cape-jkg`, `cloud-cover-total`, `cloud-cover-low`, `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`, `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`, `bl-mean-wind-v`.
- Publication timing: cycle age at most 12 hours; remaining horizon at least 48 hours.

## Scalar quantities and units

Source: [layer definitions](../packages/contracts/src/layers.ts). Each product selects the method matching its vertical coordinate. See [the data guide](data.md).

### Boundary-layer mean eastward wind (bl-mean-wind-u)

- Kind: `scalar`; quantity: `eastward-wind`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-wind-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Boundary-layer mean northward wind (bl-mean-wind-v)

- Kind: `scalar`; quantity: `northward-wind`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-wind-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### CAPE (cape-jkg)

- Kind: `scalar`; quantity: `convective-available-potential-energy`; units: `J/kg`.
- Vertical reference: `surface`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Low cloud cover (cloud-cover-low)

- Kind: `scalar`; quantity: `cloud-cover-low`; units: `%`.
- Vertical reference: `surface`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Total cloud cover (cloud-cover-total)

- Kind: `scalar`; quantity: `cloud-cover-total`; units: `%`.
- Vertical reference: `surface`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Latent heat flux (latent-heat-flux)

- Kind: `scalar`; quantity: `upward-latent-heat-flux`; units: `W/m2`.
- Vertical reference: `surface`; time support: `interval-mean`.
- Method: `native-soaring-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Mean sea-level pressure (mslp-hpa)

- Kind: `scalar`; quantity: `air-pressure`; units: `hPa`.
- Vertical reference: `MSL`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Boundary-layer height (pbl-height-agl)

- Kind: `scalar`; quantity: `boundary-layer-height`; units: `m AGL`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-soaring-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Precipitation rate (precip-rate)

- Kind: `scalar`; quantity: `precipitation-rate`; units: `mm/h`.
- Vertical reference: `surface`; time support: `interval-mean`.
- Method: `trailing-precipitation-rate-v2`; delivery: `tiles-and-samples`; palette: `rain`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Sensible heat flux (sensible-heat-flux)

- Kind: `scalar`; quantity: `upward-sensible-heat-flux`; units: `W/m2`.
- Vertical reference: `surface`; time support: `interval-mean`.
- Method: `native-soaring-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Surface dewpoint (sfc-dewpoint-c)

- Kind: `scalar`; quantity: `dew-point-temperature`; units: `degC`.
- Vertical reference: `surface`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Surface temperature (sfc-temp-c)

- Kind: `scalar`; quantity: `air-temperature`; units: `degC`.
- Vertical reference: `surface`; time support: `valid-time`.
- Method: `native-surface-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Surface LCL (surface-lcl-msl)

- Kind: `scalar`; quantity: `lifting-condensation-level`; units: `m MSL`.
- Vertical reference: `MSL`; time support: `valid-time`.
- Method: `native-cloud-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Thermal top (thermal-top-msl)

- Kind: `scalar`; quantity: `thermal-top`; units: `m MSL`.
- Vertical reference: `MSL`; time support: `interval-flux-endpoint-profile`.
- Method: `native-soaring-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: true.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Thermal velocity (thermal-velocity)

- Kind: `scalar`; quantity: `thermal-velocity`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `interval-flux-endpoint-profile`.
- Method: `native-soaring-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: true.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Usable lift depth (model AGL) (usable-lift-agl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m AGL`.
- Vertical reference: `model-AGL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-1p2-v2`; delivery: `tiles-and-samples`; palette: `lift`.
- Supports no-lift status: true; public no-lift value: `0`; supports lift flags: true.
- Zero on no-lift interpolation: true; hide nonpositive rendered values: true.

### Usable lift top (MSL) (usable-lift-msl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m MSL`.
- Vertical reference: `MSL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-1p2-v2`; delivery: `tiles-and-samples`; palette: `lift`.
- Supports no-lift status: true; public no-lift value: `null`; supports lift flags: true.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### 10 m eastward wind (wind-10m-u)

- Kind: `scalar`; quantity: `eastward-wind`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-wind-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### 10 m northward wind (wind-10m-v)

- Kind: `scalar`; quantity: `northward-wind`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-wind-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### 10 m wind gust (wind-gust-10m)

- Kind: `scalar`; quantity: `wind-gust`; units: `m/s`.
- Vertical reference: `model-AGL`; time support: `valid-time`.
- Method: `native-wind-v1`; delivery: `samples-only`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

## Status and support encodings

Public sample statuses: `valid`, `no-usable-lift`, `unavailable`, `outside-domain`.

Packed status and support bitmasks from [layer definitions](../packages/contracts/src/layers.ts):

- `STATUS_MASK`: `3`.
- `STATUS_NO_LIFT`: `1`.
- `STATUS_OUTSIDE`: `3`.
- `STATUS_UNAVAILABLE`: `2`.
- `STATUS_VALID`: `0`.
- `SUPPORT_CLOUD_CAPPED`: `128`.
- `SUPPORT_CUMULUS`: `32`.
- `SUPPORT_MASK`: `252`.
- `SUPPORT_OVERDEVELOPED`: `64`.
- `SUPPORT_PARCEL_CROSSING`: `4`.
- `SUPPORT_PBL_CLOSURE`: `16`.
- `SUPPORT_PROFILE_TOP`: `8`.

## Methods and normalized inputs

Source: [method definitions](../packages/contracts/src/methods.ts). See [science](science.md) and [extensions](extensions.md).

### dry-lenschow-1p2-model-levels-v2

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressurePa`, `hgtM`, `tempK`.
- Spatial support: `column`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
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
- Clamps normalized surface humidity up to gribQuantizationRelativeHumidityLimit times saturation vapor pressure to saturation.
- Evaluated only for cells in daylight across the trailing flux interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells emit no-lift without column evaluation.
- Interval-mean surface fluxes are paired with the endpoint profile, and usable lift requires Lenschow updraft velocity to exceed sinkRateMps (and w* above minimumThermalVelocityMps).
- A stable first resolved level uses a bounded lapse-rate extrapolation to ground; nonpositive surface excess gives zero depth.
- A profile without a resolved crossing is capped at its highest usable level and flagged.
- MSL and model-AGL outputs share one column evaluation; model terrain is not a high-resolution terrain correction.

### dry-lenschow-1p2-v2

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`.
- Spatial support: `column`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
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
- Clamps normalized surface humidity up to gribQuantizationRelativeHumidityLimit times saturation vapor pressure to saturation.
- Evaluated only for cells in daylight across the trailing flux interval or valid time (solar elevation above minimumSolarElevationDeg); nighttime cells emit no-lift without column evaluation.
- Interval-mean surface fluxes are paired with the endpoint profile, and usable lift requires Lenschow updraft velocity to exceed sinkRateMps (and w* above minimumThermalVelocityMps).
- A stable first resolved level uses a bounded lapse-rate extrapolation to ground; nonpositive surface excess gives zero depth.
- A profile without a resolved crossing is capped at its highest usable level and flagged.
- MSL and model-AGL outputs share one column evaluation; model terrain is not a high-resolution terrain correction.

### native-cloud-model-levels-v1

- Outputs: `surface-lcl-msl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Surface LCL uses the native surface parcel and Bolton condensation temperature.

### native-cloud-v1

- Outputs: `surface-lcl-msl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Surface LCL uses the native surface parcel and Bolton condensation temperature.

### native-lift-terrain-clearance-v2

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`.
- Spatial support: `bilinear-neighborhood`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
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
- `saturationRelativeTolerance`: `0.000001`.
- `sinkRateMps`: `1.2`.

Caveats:

- Interpolates native convective-depth top and buoyancy, then solves usable lift depth over the DEM for both MSL and AGL outputs.
- All positive-weight contributors must be convective to interpolate, including positive-depth no-lift columns; all non-convective or surface-stable contributors yield no lift, and mixed branches are unavailable. Support flags are combined.
- Uses the parent frame daylight interval. Nighttime with valid terrain and native geometric support emits no lift; missing terrain remains unavailable.
- Valley extrapolation is assumed and can produce usable valley lift from native no-lift columns; it is not empirically validated.
- DEM vertical datum and surface type are recorded in each patch. No vertical-datum conversion is applied.

### native-soaring-model-levels-v1

- Outputs: `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`, `sensible-heat-flux`, `latent-heat-flux`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `hgtM`, `tempK`, `pblHeightM`, `spfhKgKg`, `rhPercent`, `pressurePa`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Native shallow-column model-PBL and heat-flux closures retain positive convection below the map sink threshold. Nighttime convection is zero.

### native-soaring-v1

- Outputs: `thermal-velocity`, `thermal-top-msl`, `pbl-height-agl`, `sensible-heat-flux`, `latent-heat-flux`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `hgtM`, `tempK`, `pblHeightM`, `spfhKgKg`, `rhPercent`, `pressureLevelsHpa`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Native shallow-column model-PBL and heat-flux closures retain positive convection below the map sink threshold. Nighttime convection is zero.

### native-surface-model-levels-v1

- Outputs: `cape-jkg`, `cloud-cover-total`, `cloud-cover-low`, `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`.
- Required inputs: `temp2mK`, `specificHumidity2mKgKg`, `surfacePressurePa`, `mslpPa`, `capeJkg`, `cloudTotalPct`, `cloudLowPct`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Source CAPE parcel and cloud-layer definitions are recorded in provenance. Instantaneous gust inputs retain their source diagnostic meaning.

### native-surface-v1

- Outputs: `cape-jkg`, `cloud-cover-total`, `cloud-cover-low`, `sfc-temp-c`, `sfc-dewpoint-c`, `mslp-hpa`.
- Required inputs: `temp2mK`, `specificHumidity2mKgKg`, `surfacePressurePa`, `mslpPa`, `capeJkg`, `cloudTotalPct`, `cloudLowPct`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Source CAPE parcel and cloud-layer definitions are recorded in provenance. Instantaneous gust inputs retain their source diagnostic meaning.

### native-wind-model-levels-v1

- Outputs: `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`, `bl-mean-wind-v`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pblHeightM`, `hgtM`, `tempK`, `uWindMps`, `vWindMps`, `u10mMps`, `v10mMps`, `gust10mMps`, `pressurePa`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Earth-relative vectors integrate from model ground to resolved thermal top or model PBL top, with the 10 m vector anchored at ground; missing segments remain unavailable.

### native-wind-v1

- Outputs: `wind-10m-u`, `wind-10m-v`, `wind-gust-10m`, `bl-mean-wind-u`, `bl-mean-wind-v`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pblHeightM`, `hgtM`, `tempK`, `uWindMps`, `vWindMps`, `u10mMps`, `v10mMps`, `gust10mMps`, `pressureLevelsHpa`.
- Spatial support: `column`.

Parameters:

- `cloudCapSinkRateMps`: `1`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumShallowTemperatureC`: `1.5`.
- `minimumLevelAglM`: `20`.
- `minimumShearMps`: `0.2`.
- `minimumSolarElevationDeg`: `-0.833`.
- `minimumThermalLevels`: `3`.
- `mixedLayerPoissonExponent`: `0.2854`.
- `nearSaturationSpreadC`: `0.5`.
- `overdevelopmentRelativeHumidityPercent`: `85`.
- `pascalsPerHectopascal`: `100`.
- `saturationExponent`: `17.67`.
- `saturationTemperatureOffsetC`: `243.5`.
- `saturationVaporPressureScaleHpa`: `6.112`.
- `shallowLatentHeatCoefficient`: `0.000245268`.
- `shallowTemperaturePerFlux`: `0.012`.
- `waterDryAirMolarMassRatio`: `0.622`.

Caveats:

- All inputs belong to one normalized frame; fluxes retain their declared trailing window and profiles use its endpoint.
- Input dependencies describe the output group. Missing optional source fields leave only their dependent outputs unavailable.
- Earth-relative vectors integrate from model ground to resolved thermal top or model PBL top, with the 10 m vector anchored at ground; missing segments remain unavailable.

### supported-terrain-column-1p2-model-levels-v1

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressurePa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`.
- Spatial support: `bilinear-neighborhood`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumBelowGroundExtrapolationM`: `1000`.
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

- Reconstructs environmental temperature profiles at each DEM cell over height-supported bilinear donor columns (up to maximumBelowGroundExtrapolationM below native ground) and transfers horizontal donor-ground surface anomalies.
- Interpolates donor relative humidity and surface heat fluxes over height-supported weights, then reconstructs specific humidity at the fine temperature and hypsometric pressure. Clamps native supersaturation up to gribQuantizationRelativeHumidityLimit to saturation.
- Applies harmonic below-ground depth damping to the surface-environment ground diagnostic while lifting the dry parcel through the reconstructed profile.
- When fine terrain lies below every donor support bound (beyond maximumBelowGroundExtrapolationM), falls back to valid same-frame native-lift-terrain-clearance-v2 fields without inventing a local surface state.
- Uses the parent frame daylight interval; DEM vertical datum and surface type are recorded in each patch with no vertical-datum conversion.

### supported-terrain-column-1p2-model-levels-v2

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressurePa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `nativeCloudSupport`.
- Spatial support: `bilinear-neighborhood`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumBelowGroundExtrapolationM`: `1000`.
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

- Reconstructs environmental temperature profiles at each DEM cell over height-supported bilinear donor columns (up to maximumBelowGroundExtrapolationM below native ground) and transfers horizontal donor-ground surface anomalies.
- Interpolates donor relative humidity and surface heat fluxes over height-supported weights, then reconstructs specific humidity at the fine temperature and hypsometric pressure. Clamps native supersaturation up to gribQuantizationRelativeHumidityLimit to saturation.
- Applies harmonic below-ground depth damping to the surface-environment ground diagnostic while lifting the dry parcel through the reconstructed profile.
- When fine terrain lies below every donor support bound (beyond maximumBelowGroundExtrapolationM), falls back to valid same-frame native-lift-terrain-clearance-v2 fields without inventing a local surface state.
- Uses the parent frame daylight interval; DEM vertical datum and surface type are recorded in each patch with no vertical-datum conversion.
- Cloud support flags combine available positive-weight native-column diagnostics.

### supported-terrain-column-1p2-v1

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`.
- Spatial support: `bilinear-neighborhood`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumBelowGroundExtrapolationM`: `1000`.
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

- Reconstructs environmental temperature profiles at each DEM cell over height-supported bilinear donor columns (up to maximumBelowGroundExtrapolationM below native ground) and transfers horizontal donor-ground surface anomalies.
- Interpolates donor relative humidity and surface heat fluxes over height-supported weights, then reconstructs specific humidity at the fine temperature and hypsometric pressure. Clamps native supersaturation up to gribQuantizationRelativeHumidityLimit to saturation.
- Applies harmonic below-ground depth damping to the surface-environment ground diagnostic while lifting the dry parcel through the reconstructed profile.
- When fine terrain lies below every donor support bound (beyond maximumBelowGroundExtrapolationM), falls back to valid same-frame native-lift-terrain-clearance-v2 fields without inventing a local surface state.
- Uses the parent frame daylight interval; DEM vertical datum and surface type are recorded in each patch with no vertical-datum conversion.

### supported-terrain-column-1p2-v2

- Outputs: `usable-lift-msl`, `usable-lift-agl`.
- Required inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `nativeCloudSupport`.
- Spatial support: `bilinear-neighborhood`.

Parameters:

- `crossingEpsilonMultiplier`: `8`.
- `crossingFloat32UnitRoundoff`: `5.960464477539063e-8`.
- `dryAirGasConstantJkgK`: `287.05`.
- `dryAirHeatCapacityJkgK`: `1004`.
- `dryLapseRateKperM`: `0.0098`.
- `gravityMps2`: `9.80665`.
- `gribQuantizationRelativeHumidityLimit`: `1.05`.
- `kelvinOffset`: `273.15`.
- `latentHeatVaporizationJkg`: `2501000`.
- `lenschowPeakZeta`: `0.3125`.
- `lenschowScale`: `4`.
- `lenschowShape`: `0.8`.
- `maximumBelowGroundExtrapolationM`: `1000`.
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

- Reconstructs environmental temperature profiles at each DEM cell over height-supported bilinear donor columns (up to maximumBelowGroundExtrapolationM below native ground) and transfers horizontal donor-ground surface anomalies.
- Interpolates donor relative humidity and surface heat fluxes over height-supported weights, then reconstructs specific humidity at the fine temperature and hypsometric pressure. Clamps native supersaturation up to gribQuantizationRelativeHumidityLimit to saturation.
- Applies harmonic below-ground depth damping to the surface-environment ground diagnostic while lifting the dry parcel through the reconstructed profile.
- When fine terrain lies below every donor support bound (beyond maximumBelowGroundExtrapolationM), falls back to valid same-frame native-lift-terrain-clearance-v2 fields without inventing a local surface state.
- Uses the parent frame daylight interval; DEM vertical datum and surface type are recorded in each patch with no vertical-datum conversion.
- Cloud support flags combine available positive-weight native-column diagnostics.

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

### trailing-precipitation-rate-v2

- Outputs: `precip-rate`.
- Required inputs: `precipitationMmPerHour`.
- Spatial support: `column`.

Parameters:

- `minimumRateMmPerHour`: `0`.

Caveats:

- The adapter supplies liquid-water-equivalent rate for the declared trailing interval, including accumulation differencing.
- Evaluated at every retained forecast time. Negative, non-finite or explicitly missing rates are unavailable.

### Normalized input vocabulary

- `capeJkg`: `convective-available-potential-energy`; units `J/kg`; dimensions `cell`; vertical reference `source parcel declared in provenance`; time support `valid-time`; missingness `explicit-cell-mask`.
- `cloudLowPct`: `cloud-cover-low`; units `%`; dimensions `cell`; vertical reference `source low-cloud layer`; time support `valid-time`; missingness `explicit-cell-mask`.
- `cloudTotalPct`: `cloud-cover-total`; units `%`; dimensions `cell`; vertical reference `atmospheric column`; time support `valid-time`; missingness `explicit-cell-mask`.
- `gust10mMps`: `wind-gust`; units `m/s`; dimensions `cell`; vertical reference `10 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `hgtM`: `geopotential-height`; units `m`; dimensions `level-cell`; vertical reference `MSL at profile levels (isobaric or model levels)`; time support `valid-time`; missingness `explicit-cell-mask`.
- `latentHeatFluxWm2`: `upward-latent-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `mslpPa`: `mean-sea-level-pressure`; units `Pa`; dimensions `cell`; vertical reference `MSL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `omegaPaS`: `pressure-vertical-velocity`; units `Pa/s`; dimensions `level-cell`; vertical reference `native model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `pblHeightM`: `boundary-layer-height`; units `m`; dimensions `cell`; vertical reference `model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `precipitationMmPerHour`: `liquid-water-equivalent-precipitation-rate`; units `mm/h`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `pressureLevelsHpa`: `air-pressure-coordinate`; units `hPa`; dimensions `level`; vertical reference `strictly decreasing isobaric levels`; time support `static`; missingness `all-levels-required`.
- `pressurePa`: `air-pressure`; units `Pa`; dimensions `level-cell`; vertical reference `terrain-following model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `rhPercent`: `relative-humidity`; units `%`; dimensions `level-cell`; vertical reference `native model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `sensibleHeatFluxWm2`: `upward-sensible-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `specificHumidity2mKgKg`: `specific-humidity`; units `kg/kg`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `spfhKgKg`: `specific-humidity`; units `kg/kg`; dimensions `level-cell`; vertical reference `native model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `surfacePressurePa`: `air-pressure`; units `Pa`; dimensions `cell`; vertical reference `surface`; time support `valid-time`; missingness `explicit-cell-mask`.
- `temp2mK`: `air-temperature`; units `K`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `tempK`: `air-temperature`; units `K`; dimensions `level-cell`; vertical reference `profile levels (isobaric or model levels)`; time support `valid-time`; missingness `explicit-cell-mask`.
- `terrainM`: `geopotential-height`; units `m`; dimensions `cell`; vertical reference `MSL`; time support `static`; missingness `explicit-cell-mask`.
- `u10mMps`: `eastward-wind`; units `m/s`; dimensions `cell`; vertical reference `10 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `uWindMps`: `eastward-wind`; units `m/s`; dimensions `level-cell`; vertical reference `native model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `v10mMps`: `northward-wind`; units `m/s`; dimensions `cell`; vertical reference `10 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `vWindMps`: `northward-wind`; units `m/s`; dimensions `level-cell`; vertical reference `native model levels`; time support `valid-time`; missingness `explicit-cell-mask`.

## Resource limits

Configured limits from [capacity.ts](../apps/batch/src/capacity.ts) and [serving budgets](serving-budgets.md).

Complete-build limits:

- `elapsedMs`: `5400000`.
- `gridCells`: `4000000`.
- `numericBytes`: `68719476736`.
- `peakRssBytes`: `2147483648`.
- `samplePackBytes`: `268435456`.
- `tiles`: `5000000`.

Shared limits and storage constants:

- `CELL_BYTES`: `5`.
- `DEFAULT_PROBE_TIMEOUT_MS`: `30000`.
- `DEFAULT_REQUEST_TIMEOUT_MS`: `15000`.
- `MAX_COVERAGE_BITSET_BYTES`: `524288`.
- `MAX_COVERAGE_DESCRIPTOR_BYTES`: `131072`.
- `MAX_FORECAST_SHARDS`: `256`.
- `MAX_GRID_CELLS`: `4000000`.
- `MAX_JSON_CONTAINER_ENTRIES`: `256`.
- `MAX_MANIFEST_BYTES`: `524288`.
- `MAX_MANIFEST_JSON_TOKENS`: `16384`.
- `MAX_METADATA_JSON_TOKENS`: `8192`.
- `MAX_MODEL_WORKERS`: `3`.
- `MAX_NATIVE_ZOOM`: `10`.
- `MAX_PACK_CHANNELS`: `8192`.
- `MAX_POINTER_BYTES`: `131072`.
- `MAX_POINT_RESPONSE_BYTES`: `1048576`.
- `MAX_PROFILE_LEVELS`: `256`.
- `MAX_PROVENANCE_BYTES`: `4194304`.
- `MAX_PROVENANCE_JSON_TOKENS`: `262144`.
- `MAX_RETAINED_BUILDS`: `256`.
- `MAX_SAMPLE_POINTS`: `64`.
- `MAX_SAMPLE_RANGE_BYTES`: `262144`.
- `MAX_SAMPLE_VALUES`: `256`.
- `MAX_SPARSE_COVERAGE_BYTES`: `268435456`.
- `MAX_TILE_BYTES`: `1048576`.
- `RETENTION_DAYS`: `7`.
- `SAMPLE_BLOCK_SIZE`: `16`.

Raster worker limits ([source](../apps/batch/src/raster-pool.ts)):

- `MAX_RASTER_WORKERS`: 3.
- `MAX_RASTER_SHARED_INPUT_BYTES`: 67108864.
- `RASTER_WORKER_RESOURCE_LIMITS`: `{"maxOldGenerationSizeMb":64,"maxYoungGenerationSizeMb":16,"stackSizeMb":4}` (V8 heap/stack ceiling per worker).
- `RASTER_WORKER_NATIVE_RESERVE_MB`: 44.
- `RASTER_WORKER_RESERVE_BYTES`: 134217728; memory reserved per worker derived from the V8 heap/stack ceiling plus native allowance.

## API reference

The checked-in [OpenAPI document](reference/openapi.json) is generated from the Worker’s `GET /openapi.json` route and served interactively at `/docs`.

- `GET /docs`.
- `GET /healthz`.
- `GET /openapi.json`.
- `GET /tiles/{model}/{buildId}/{layer}/{frame}/{z}/{x}/{y}.webp`.
- `GET /v1/catalog`.
- `GET /v1/models/{model}/latest`.
- `GET /v1/models/{model}/runs`.
- `GET /v1/models/{model}/runs/{buildId}`.
- `GET /v1/models/{model}/runs/{buildId}/layers/{layer}/{frame}/tilejson.json`.
- `GET /v1/models/{model}/runs/{buildId}/profile`.
- `GET /v1/models/{model}/runs/{buildId}/provenance`.
- `GET /v1/models/{model}/runs/{buildId}/sample`.
- `GET /v1/models/{model}/runs/{buildId}/samples`.
- `GET /v1/palettes/{id}.json`.
- `GET /v1/palettes/{id}.svg`.
