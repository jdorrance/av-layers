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

Source: [model settings](../packages/contracts/config/models.json). See [deployments](status.md) for live applications and runs.

Forecast trigger budget: 20 shard jobs; default workers 3.

### GFS (gfs-soaring)

- Public model ID: `gfs`; model family: `gfs`; source configuration: `noaa-gfs-0p25`; domain: `global`.
- Attribution: NOAA GFS · Aviation Forecast Layers.
- Grid: `regular-latlon`; 1440 columns × 721 rows; spherical Earth radius 6371229 m; periodic longitude: true.
- Terrain subdivision factor: `10`; fine grid: 14400 columns × 7201 rows.
- Bounds [west, south, east, north]: `[-180,-55,180,65]`.
- Coverage: `soaring-land-v1`. Land and coastal buffer between 55°S and 65°N; Russia, China, Greenland, Antarctica and Africa excluded.
- Native tile zoom: 0–9.
- Execution: 12 target shards; at most 12 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["17 5,17 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]`; interval: 1 hours; frame policy: `all-hours`.
- Vertical coordinate: `isobaric`; maximum levels: 21.
- Calculation methods: `supported-terrain-column-1p2-v1`, `trailing-precipitation-rate-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `precipitationMmPerHour`.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`.
- Publication timing: cycle age at most 18 hours; remaining horizon at least 6 hours.

### ICON-EU (icon-eu-soaring)

- Public model ID: `icon-eu`; model family: `icon`; source configuration: `dwd-icon-eu-regular-0p0625`; domain: `europe`.
- Attribution: DWD ICON-EU (CC BY 4.0) · Aviation Forecast Layers.
- Grid: `regular-latlon`; 1377 columns × 657 rows; spherical Earth radius 6371229 m; periodic longitude: false.
- Terrain subdivision factor: `5`; fine grid: 6881 columns × 3281 rows.
- Bounds [west, south, east, north]: `[-23.5,29.5,62.5,70.5]`.
- Coverage: `icon-eu-land-v1`. Land and 50 km coastal buffer across the DWD ICON-EU regridded regular-lat-lon domain (23.5°W–62.5°E, 29.5°N–70.5°N); Russia, China, Greenland, Antarctica and Africa excluded.
- Native tile zoom: 0–10.
- Execution: 8 target shards; at most 8 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["17 5,17 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]`; interval: 1 hours; frame policy: `regional-daylight`.
- Vertical coordinate: `model-levels`; maximum levels: 30.
- Calculation methods: `supported-terrain-column-1p2-model-levels-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressurePa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`.
- Layers: `usable-lift-msl`, `usable-lift-agl`.
- Publication timing: cycle age at most 18 hours; remaining horizon at least 6 hours.

### RRFS (CONUS) (rrfs-conus-soaring)

- Public model ID: `rrfs`; model family: `rrfs`; source configuration: `noaa-rrfs-conus-3km`; domain: `conus`.
- Attribution: NOAA RRFS · Aviation Forecast Layers.
- Grid: `lambert-conformal`; 1799 columns × 1059 rows; spherical Earth radius 6371229 m; periodic longitude: false.
- Terrain subdivision factor: `2`; fine grid: 3597 columns × 2117 rows.
- Bounds [west, south, east, north]: `[-134.121428,21.122192,-60.891244,52.628704]`.
- Coverage: `rrfs-conus-land-v1`. Land and 50 km coastal buffer within the operational 3 km CONUS Lambert grid, including adjacent Canadian and Mexican coverage.
- Native tile zoom: 0–10.
- Execution: 24 target shards; at most 20 simultaneous shard jobs; worker ceiling 3; UTC cron schedules `["27 3,9,15,21 * * *"]`.
- Candidate forecast lead hours: `[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24]`; interval: 1 hours; frame policy: `all-hours`.
- Vertical coordinate: `isobaric`; maximum levels: 25.
- Calculation methods: `supported-terrain-column-1p2-v1`, `trailing-precipitation-rate-v1`.
- Required calculation inputs: `terrainM`, `surfacePressurePa`, `temp2mK`, `specificHumidity2mKgKg`, `sensibleHeatFluxWm2`, `latentHeatFluxWm2`, `pressureLevelsHpa`, `hgtM`, `tempK`, `convectiveDepthTopMslM`, `buoyancyM2S3`, `branch`, `terrainElevationM`, `precipitationMmPerHour`.
- Layers: `usable-lift-msl`, `usable-lift-agl`, `precip-rate`.
- Publication timing: cycle age at most 12 hours; remaining horizon at least 6 hours.

## Scalar quantities and units

Source: [layer definitions](../packages/contracts/src/layers.ts). Each product selects the method matching its vertical coordinate. See [the data guide](data.md).

### Precipitation rate (precip-rate)

- Kind: `scalar`; quantity: `precipitation-rate`; units: `mm/h`.
- Vertical reference: `surface`; time support: `interval-mean`.
- Method: `trailing-precipitation-rate-v1`; palette: `rain`.
- Supports no-lift status: false; public no-lift value: `null`; supports lift flags: false.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

### Usable lift depth (model AGL) (usable-lift-agl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m AGL`.
- Vertical reference: `model-AGL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-1p2-v2`; palette: `lift`.
- Supports no-lift status: true; public no-lift value: `0`; supports lift flags: true.
- Zero on no-lift interpolation: true; hide nonpositive rendered values: true.

### Usable lift top (MSL) (usable-lift-msl)

- Kind: `scalar`; quantity: `usable-lift-top`; units: `m MSL`.
- Vertical reference: `MSL`; time support: `interval-flux-endpoint-profile`.
- Method: `dry-lenschow-1p2-v2`; palette: `lift`.
- Supports no-lift status: true; public no-lift value: `null`; supports lift flags: true.
- Zero on no-lift interpolation: false; hide nonpositive rendered values: false.

## Status and support encodings

Public sample statuses: `valid`, `no-usable-lift`, `unavailable`, `outside-domain`.

Packed status and support bitmasks from [layer definitions](../packages/contracts/src/layers.ts):

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

- `hgtM`: `geopotential-height`; units `m`; dimensions `level-cell`; vertical reference `MSL at profile levels (isobaric or model levels)`; time support `valid-time`; missingness `explicit-cell-mask`.
- `latentHeatFluxWm2`: `upward-latent-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `precipitationMmPerHour`: `liquid-water-equivalent-precipitation-rate`; units `mm/h`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `pressureLevelsHpa`: `air-pressure-coordinate`; units `hPa`; dimensions `level`; vertical reference `strictly decreasing isobaric levels`; time support `static`; missingness `all-levels-required`.
- `pressurePa`: `air-pressure`; units `Pa`; dimensions `level-cell`; vertical reference `terrain-following model levels`; time support `valid-time`; missingness `explicit-cell-mask`.
- `sensibleHeatFluxWm2`: `upward-sensible-heat-flux`; units `W/m2`; dimensions `cell`; vertical reference `surface`; time support `interval-mean`; missingness `explicit-cell-mask`.
- `specificHumidity2mKgKg`: `specific-humidity`; units `kg/kg`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `surfacePressurePa`: `air-pressure`; units `Pa`; dimensions `cell`; vertical reference `surface`; time support `valid-time`; missingness `explicit-cell-mask`.
- `temp2mK`: `air-temperature`; units `K`; dimensions `cell`; vertical reference `2 m model AGL`; time support `valid-time`; missingness `explicit-cell-mask`.
- `tempK`: `air-temperature`; units `K`; dimensions `level-cell`; vertical reference `profile levels (isobaric or model levels)`; time support `valid-time`; missingness `explicit-cell-mask`.
- `terrainM`: `geopotential-height`; units `m`; dimensions `cell`; vertical reference `MSL`; time support `static`; missingness `explicit-cell-mask`.

## Resource limits

Configured limits from [capacity.ts](../apps/batch/src/capacity.ts) and [serving budgets](serving-budgets.md).

Complete-build limits:

- `elapsedMs`: `3000000`.
- `gridCells`: `4000000`.
- `peakRssBytes`: `2147483648`.
- `samplePackBytes`: `268435456`.
- `tiles`: `4000000`.

Shared limits and storage constants:

- `CELL_BYTES`: `5`.
- `DEFAULT_PROBE_TIMEOUT_MS`: `30000`.
- `DEFAULT_REQUEST_TIMEOUT_MS`: `15000`.
- `MAX_COVERAGE_BITSET_BYTES`: `524288`.
- `MAX_COVERAGE_DESCRIPTOR_BYTES`: `131072`.
- `MAX_GRID_CELLS`: `4000000`.
- `MAX_MANIFEST_BYTES`: `524288`.
- `MAX_METADATA_JSON_TOKENS`: `8192`.
- `MAX_MODEL_WORKERS`: `3`.
- `MAX_NATIVE_ZOOM`: `10`.
- `MAX_POINTER_BYTES`: `131072`.
- `MAX_PROVENANCE_BYTES`: `4194304`.
- `MAX_PROVENANCE_JSON_TOKENS`: `262144`.
- `MAX_RETAINED_BUILDS`: `256`.
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
- `GET /v1/models/{model}/runs/{buildId}/provenance`.
- `GET /v1/models/{model}/runs/{buildId}/sample`.
- `GET /v1/palettes/{id}.json`.
- `GET /v1/palettes/{id}.svg`.
