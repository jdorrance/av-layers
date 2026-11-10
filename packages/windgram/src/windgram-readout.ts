// Format inspector readings; DOM interaction lives in windgram-dom.ts.
import { fahrenheitToCelsius, formatQuantity, knotsToMps, type UnitSystem } from './windgram-format.ts';
import { CLOUD_RH_THRESHOLD_PERCENT } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';
import type { WindgramReading } from './scene-types.ts';

const barbSpeed = (knots: number, system: UnitSystem) => formatQuantity(knotsToMps(knots), 'wind', undefined, system);
const degrees = (direction: number) => `${['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(direction / 22.5) % 16]} ${Math.round(direction) % 360}°`;
const windSources = {
  'surface-10m': 'Native 10 m wind',
  'model-level': 'Model level', interpolated: 'Interpolated',
};
const cloudLabels = {
  humidity: `Likely cloud layer from interpolated RH ≥${CLOUD_RH_THRESHOLD_PERCENT}%`, potential: 'Potential cloud base',
};

function surfaceDetails(view: WindgramView, reading: WindgramReading): string[] {
  const system = view.unitSystem;
  const rainLabel = view.precipitationSemantics === 'instantRate' ? 'Rain rate sample'
    : view.precipitationSemantics === 'windowMeanRate' ? 'Mean rain rate (preceding interval)' : 'Rain rate (timing unspecified)';
  const layer = reading.publishedLayerWind;
  const wind = (speed: number | null, direction: number | null) => speed === null ? 'unavailable'
    : `${formatQuantity(speed, 'wind', undefined, system)}${direction === null || speed === 0 ? '' : ` from ${degrees(direction)}`}`;
  return [
    `Model surface wind ${wind(reading.surfaceWindSpeedMps, reading.surfaceWindDirectionDeg)}`,
    reading.gustKt === null ? null : `${view.gustLabel} ${barbSpeed(reading.gustKt, system)}`,
    reading.precipitationMmHr === null ? 'Rain rate unavailable' : `${rainLabel} ${formatQuantity(reading.precipitationMmHr, 'rainRate', undefined, system)}`,
    `${view.capeLabel} ${reading.capeJkg === null ? 'unavailable' : `${Math.round(reading.capeJkg)} J/kg`}`,
    ...([['Model ground', reading.modelTerrainM], ['Native potential cloud base (surface LCL)', reading.cloudBaseM],
      ['Native effective cloud limit', reading.effectiveCloudLimitM],
      ['Native thermal top (parcel)', reading.nativeThermalTopM],
      ['Model boundary-layer top', reading.modelPblTopM]] as const)
      .map(([label, height]) => height === null ? null : `${label} ${formatQuantity(height, 'elevation', undefined, system)} MSL`),
    ...(layer ? [`Layer mean wind ${wind(layer.meanSpeedMps, layer.meanDirectionDeg)}`,
      `Layer top wind ${wind(layer.topSpeedMps, layer.topDirectionDeg)}`,
      `Surface-to-layer-top shear ${layer.surfaceToTopShearMps === null ? 'unavailable' : formatQuantity(layer.surfaceToTopShearMps, 'wind', undefined, system)}`] : []),
  ].filter((text): text is string => text !== null);
}

export function formatWindgramReading(view: WindgramView, reading: WindgramReading, scope: 'surface' | 'height'): string[] {
  if (scope === 'surface') return surfaceDetails(view, reading);
  const system = view.unitSystem;
  return [
    reading.temperatureF == null ? 'Temperature unavailable' : `${formatQuantity(fahrenheitToCelsius(reading.temperatureF), 'temperature', 1, system)}`,
    reading.speedKt == null
      ? 'Wind unavailable'
      : reading.speedKt < 0.1
        ? 'Calm'
        : `${barbSpeed(reading.speedKt, system)}${reading.directionDeg == null ? '' : ` from ${degrees(reading.directionDeg)}`}`,
    reading.windSource === null ? null : windSources[reading.windSource],
    reading.windShear === null ? 'Layer wind shear unavailable' : `Layer wind shear ${reading.windShear.perKmMps.toFixed(1)} m/s per km (${formatQuantity(reading.windShear.lowerM, 'elevation', undefined, system)}–${formatQuantity(reading.windShear.upperM, 'elevation', undefined, system)} MSL)`,
    reading.dewPointC === null ? 'Dew point unavailable' : `Dew point ${formatQuantity(reading.dewPointC, 'temperature', 1, system)}`,
    reading.relativeHumidityPercent === null ? 'RH unavailable' : `RH ${Math.round(reading.relativeHumidityPercent)}%`,
    reading.verticalVelocityPaS === null ? reading.verticalVelocityUnavailableReason : `Vertical motion ${reading.verticalVelocityPaS.toFixed(2)} Pa/s (${reading.verticalVelocityPaS < 0 ? 'ascent' : reading.verticalVelocityPaS > 0 ? 'descent' : 'neutral'}; ${reading.verticalVelocitySource === 'model-level' ? 'model level' : 'interpolated'})`,
    reading.cloud === null ? null : cloudLabels[reading.cloud],
    ...surfaceDetails(view, reading),
  ].filter((value): value is string => value !== null);
}
