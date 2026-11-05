import type { TerrainDomain } from '@av/contracts';
export type { SolarSite, SolarTerrainOptions, SolarTerrainBuild, SolarTerrainProduct, SolarTerrainIndex, TerrainTile, TerrainDomain, ElevationGrid, ReliefProduct, TerrainBounds, SolarDomainOptions } from '@av/contracts';
export interface ReliefFrame { domain: TerrainDomain; zoom: number; f: number; x0: number; y0: number; width: number; height: number; values: Uint16Array; min: number; max: number }
export interface SurfaceLevel { z: number; x0: number; y0: number; width: number; height: number; nx: Float32Array; ny: Float32Array; nz: Float32Array; svf: Float32Array }
export interface HorizonGrid { x0: number; y0: number; width: number; height: number; horizons: Float32Array[] }
