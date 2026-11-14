export const KPH_PER_MPS = 3.6;
export const MPH_PER_MPS = 3600 / 1609.344;
export const KNOTS_PER_MPS = 3600 / 1852;
export const DISPLAY_MPH_PER_MPS = 2.2369362921;
export const DISPLAY_KNOTS_PER_MPS = 1.9438444924;

export type WindSpeedSystem = 'metric' | 'imperial' | 'knots';

export function windSpeedUnitLabel(system: WindSpeedSystem): 'km/h' | 'mph' | 'kt' {
  return system === 'knots' ? 'kt' : system === 'imperial' ? 'mph' : 'km/h';
}

/** Map labels and barb feathers classify the same truncated display speed. */
export function displayedWindSpeed(speedMps: number, system: WindSpeedSystem): number | null {
  const speed = speedMps * (system === 'knots' ? DISPLAY_KNOTS_PER_MPS : system === 'imperial' ? DISPLAY_MPH_PER_MPS : KPH_PER_MPS);
  return Number.isFinite(speed) && speed >= 0 ? Math.trunc(speed) : null;
}

export function quantizedBarbSpeed(speed: number): number {
  return speed > 0 ? Math.max(5, Math.round(speed / 5) * 5) : 0;
}
