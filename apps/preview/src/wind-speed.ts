import type { UnitSystem } from '@av/client';
import { DISPLAY_MPH_PER_MPS, KPH_PER_MPS } from '@av/contracts/units';

export function displayedWindSpeed(u: number, v: number, units: UnitSystem): number | null {
  const speed = Math.hypot(u, v) * (units === 'metric' ? KPH_PER_MPS : DISPLAY_MPH_PER_MPS);
  return Number.isFinite(speed) ? Math.trunc(speed) : null;
}
