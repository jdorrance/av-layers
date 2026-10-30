import {
  GFS_CONTRACT_GRID,
  GFS_FORECAST_HOURS,
  GFS_PRESSURE_LEVELS_HPA,
  GFS_PRODUCTS,
} from '../noaa/constants.ts';
import { discoverGfsRun } from '../noaa/discover.ts';
import { acquireGfsFrame } from '../noaa/acquire.ts';
import { proveGfsInputs } from '../noaa/prove.ts';
import type { AcquireGfsFrameOptions, DiscoverGfsRunOptions, ProveGfsInputsOptions } from '../noaa/types.ts';

export const gfsProvider = Object.freeze({
  id: 'gfs' as const,
  label: 'NOAA GFS 0.25 degree',
  grid: GFS_CONTRACT_GRID,
  products: GFS_PRODUCTS,
  forecastHours: GFS_FORECAST_HOURS,
  pressureLevelsHpa: GFS_PRESSURE_LEVELS_HPA,
  discover: (options: DiscoverGfsRunOptions = {}) => discoverGfsRun(options),
  acquireFrame: (options: AcquireGfsFrameOptions) => acquireGfsFrame(options),
  proveInputs: (options: ProveGfsInputsOptions = {}) => proveGfsInputs(options),
});

export type GfsProvider = typeof gfsProvider;
