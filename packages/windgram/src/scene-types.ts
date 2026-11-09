import type { UnitSystem } from './windgram-format.ts';

export const windgramScene = Symbol('WindgramView');
export interface WindgramHour {
  readonly validAt: string;
  readonly label: string;
  readonly x: number;
  /** Published lift ceiling, metres MSL. */
  readonly usableLiftTopM: number | null;
  readonly thermalVelocityMps: number | null;
}
/** Create with buildWindgramView; retain the returned object for rendering and inspection. */
export interface WindgramLayout {
  readonly unitSystem: UnitSystem;
  readonly timeZone: string;
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly top: number;
  readonly plotWidth: number;
  readonly plotHeight: number;
  readonly bottom: number;
  readonly columnWidth: number;
  readonly floorM: number;
  readonly topM: number;
  readonly compact: boolean;
  /** Selected hour from which keyboard inspection begins. */
  selectedHourIndex: number;
}
export interface WindgramView extends WindgramLayout {
  readonly [windgramScene]: true;
  readonly hours: readonly WindgramHour[];
}
export interface WindgramHourFilterOptions {
  timeZone: string;
  hours?: readonly { validAt: string }[] | { timeZone: string; dateKey: string };
}
export interface WindgramOptions extends WindgramHourFilterOptions {
  unitSystem: UnitSystem;
  widthPx?: number;
  /** Maximum rendered chart height, including the axes. */
  heightPx?: number;
  compact?: boolean;
  /** Vertical extent; single-day charts retain sunrise through sunset. */
  heightRange?: 'soaring' | 'full';
}
export interface WindgramReading {
  hourIndex: number;
  validAt: string;
  heightM: number;
  heightAglM: number | null;
  heightAglReference: 'terrain' | 'model' | null;
  temperatureF: number | null;
  speedKt: number | null;
  directionDeg: number | null;
  gustKt: number | null;
  cloud: 'humidity' | 'potential' | null;
  /** Moisture and omega at the inspected height; omega < 0 is ascent. */
  dewPointC: number | null;
  relativeHumidityPercent: number | null;
  verticalVelocityPaS: number | null;
  windSource: 'surface-10m' | 'model-level' | 'interpolated' | null;
  /** Vector wind change between surrounding native nodes. Bounds: metres MSL;
   * gradient: m/s per km. Missing or duplicate nodes yield null. */
  windShear: { lowerM: number; upperM: number; vectorChangeMps: number; perKmMps: number } | null;
  verticalVelocitySource: 'model-level' | 'interpolated' | null;
  verticalVelocityUnavailableReason: string | null;
  /** Surface weather is available independently of lift. */
  surfaceWindSpeedMps: number | null;
  surfaceWindDirectionDeg: number | null;
  precipitationMmHr: number | null;
  capeJkg: number | null;
  cloudBaseM: number | null;
  effectiveCloudLimitM: number | null;
  modelTerrainM: number | null;
  nativeThermalTopM: number | null;
  modelPblTopM: number | null;
  /** Published V2 layer diagnostics, independent of inspected height.
   * Speeds and surface-to-layer-top vector shear are m/s; bearings are wind-from
   * degrees clockwise from true north. */
  publishedLayerWind: {
    meanSpeedMps: number | null; meanDirectionDeg: number | null;
    topSpeedMps: number | null; topDirectionDeg: number | null;
    surfaceToTopShearMps: number | null;
  } | null;
}
export interface WindgramSvgOptions { idPrefix?: string }
