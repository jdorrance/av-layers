export const KPH_PER_MPS = 3.6;
export const MPH_PER_MPS = 3600 / 1609.344;
export const DISPLAY_MPH_PER_MPS = Number(MPH_PER_MPS.toFixed(10));

/** Map labels and barb feathers classify the same truncated display speed. */
export function displayedWindSpeed(speedMps: number, system: 'metric' | 'imperial'): number | null {
  const speed = speedMps * (system === 'metric' ? KPH_PER_MPS : DISPLAY_MPH_PER_MPS);
  return Number.isFinite(speed) && speed >= 0 ? Math.trunc(speed) : null;
}
