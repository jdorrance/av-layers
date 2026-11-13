import { gridSchema, gridToGeographic, type ModelDefinition } from '@av/contracts';
import { getProduct } from '@av/contracts/models';
import ready from './wrf-zarr/_ready.json' with { type: 'json' };

const base = getProduct('wrf-armenia-3km')!, grid = gridSchema.parse(ready.grid);
const points = Array.from({ length: grid.width * grid.height }, (_, index) => gridToGeographic(grid, index % grid.width, Math.floor(index / grid.width))!);
const lower = (values: number[]) => Math.floor(Math.min(...values) * 1e6) / 1e6;
const upper = (values: number[]) => Math.ceil(Math.max(...values) * 1e6) / 1e6;
const bounds = [lower(points.map(point => point.lon)), lower(points.map(point => point.lat)),
  upper(points.map(point => point.lon)), upper(points.map(point => point.lat))] as const;
export const WRF_ZARR_CYCLE = new Date(ready.publish_origin_utc).toISOString();
export const WRF_ZARR_FIXTURE: ModelDefinition = {
  ...base, modelId: ready.model_id, id: 'wrf-fixture-soaring', coverageId: 'wrf-fixture-land', coverageDir: 'coverage/wrf-fixture-land',
  label: 'WRF encoded fixture', attribution: 'Synthetic av-wrf fixture', coverageDescription: 'Synthetic av-wrf coverage',
  source: { modelFamily: 'wrf', configurationId: 'wrf-fixture', domainId: 'fixture' },
  grid, bounds, frameHours: ready.lead_hours, mapEndHour: 2, intervalChange: undefined, maxNativeZoom: 0,
  capabilities: { ...base.capabilities, maxVerticalLevels: ready.exported_levels_k },
  forecast: { ...base.forecast, hours: ready.lead_hours, mapEndHour: 2, intervalChange: undefined },
  execution: { ...base.execution, shards: 1, parallelism: 1, workers: 0 }, freshness: { maxCycleAgeHours: 48, minHorizonHours: 0 }
};
