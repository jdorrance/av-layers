import { gridToGeographic, type Grid } from '@av/contracts';
import { getProduct, type ModelDefinition } from '@av/contracts/models';

const base = getProduct('rrfs')!;
// The second frame keeps the window live until the next local daylight cycle.
const mapEndHour = 26;
const forecastHours = [1, mapEndHour];
export const UPP_PRESSURE_LEVELS = [950, 900, 850] as const;

function uppProduct(region: string, grid: Extract<Grid, { kind: 'lambert-conformal' }>, terrainSubdivisionFactor: number): ModelDefinition {
  const modelId = `upp-${region}-fixture`;
  const corners = [0, grid.width - 1].flatMap(x => [0, grid.height - 1].map(y => gridToGeographic(grid, x, y)!));
  const latitudes = corners.map(point => point.lat), longitudes = corners.map(point => point.lon);
  const lower = (values: number[]) => Math.floor(Math.min(...values) * 1e6) / 1e6;
  const upper = (values: number[]) => Math.ceil(Math.max(...values) * 1e6) / 1e6;
  return {
    ...base, id: `${modelId}-v5`, modelId, label: `UPP ${region} fixture`, coverageId: `${modelId}-land`,
    source: { modelFamily: 'wrf', configurationId: `${modelId}-source`, domainId: region }, tier: 'high', expectedRunsPerDay: 4,
    bounds: [lower(longitudes), lower(latitudes), upper(longitudes), upper(latitudes)],
    attribution: 'Synthetic indexed GRIB2', coverageDescription: 'Synthetic Lambert coverage', grid,
    maxNativeZoom: 0, nominalDxMeters: Math.abs(grid.dxM), terrainSubdivisionFactor, frameHours: forecastHours, mapEndHour,
    capabilities: { ...base.capabilities, maxVerticalLevels: UPP_PRESSURE_LEVELS.length },
    freshness: { maxCycleAgeHours: 25, minHorizonHours: 0 },
    execution: { ...base.execution, schedule: [], shards: 2, workers: 1 },
    forecast: { hours: forecastHours, intervalHours: 1, mapEndHour, cycleHoursUtc: Array.from({ length: 24 }, (_, i) => i), statisticsResetHours: 1 },
    upstream: { ...base.upstream, provider: 'Synthetic UPP', subCentre: 0, lambertSouthPoleLatitude: 0,
      urlTemplate: `r2://upstream/${modelId}/{date}/{cycleHour}/wrf.t{cycleHour}z.{product}.f{hour}.grib2`,
      pressureLevelsHpa: { profile: [...UPP_PRESSURE_LEVELS] } }
  };
}

const grid = { kind: 'lambert-conformal', width: 18, height: 18, wrapLongitude: false } as const;
export const UPP_ARMENIA = uppProduct('armenia', { ...grid, earthRadiusM: 6371229, centralMeridianDeg: 44.5,
  latitudeOfOriginDeg: 39, standardParallel1Deg: 39, standardParallel2Deg: 41.4,
  x0M: -24_000, y0M: 110_000, dxM: 3000, dyM: 3000 }, 3);
export const UPP_NEW_ZEALAND = uppProduct('nz', { ...grid, earthRadiusM: 6370000, centralMeridianDeg: 172.5,
  latitudeOfOriginDeg: -44, standardParallel1Deg: -44, standardParallel2Deg: -38,
  x0M: -8_000, y0M: 300_000, dxM: 1000, dyM: 1000 }, 1);
