export const KPH_PER_MPS = 3.6;
export const MPH_PER_MPS = 3600 / 1609.344;
export const KNOTS_PER_MPS = 3600 / 1852;
export const DISPLAY_MPH_PER_MPS = 2.2369362921;
export const DISPLAY_KNOTS_PER_MPS = 1.9438444924;
export const CALM_BARB_KNOTS = 2.5;

export type WindSpeedSystem = 'metric' | 'imperial' | 'knots';

export function windSpeedUnitLabel(system: WindSpeedSystem): 'km/h' | 'mph' | 'kt' {
  return system === 'knots' ? 'kt' : system === 'imperial' ? 'mph' : 'km/h';
}

/** Map and point labels truncate the converted display speed. */
export function displayedWindSpeed(speedMps: number, system: WindSpeedSystem): number | null {
  const speed = speedMps * (system === 'knots' ? DISPLAY_KNOTS_PER_MPS : system === 'imperial' ? DISPLAY_MPH_PER_MPS : KPH_PER_MPS);
  return Number.isFinite(speed) && speed >= 0 ? Math.trunc(speed) : null;
}

/** WMO/ICAO wind barbs quantize true knots to the nearest 5 kt, with calm below 2.5 kt. */
export function quantizedBarbSpeed(speedKt: number): number {
  return Number.isFinite(speedKt) && speedKt >= CALM_BARB_KNOTS ? Math.round(speedKt / 5) * 5 : 0;
}
