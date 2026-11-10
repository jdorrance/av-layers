import type { LayerId } from '@av/contracts';
import { longitudeOffsetHours, pointMapLift, type GeoPoint, type PinnedBuild, type PointFrame } from '@av/contracts/client';
import { windFromComponents } from '@av/soaring';
import type { PublishedForecastHour, SiteForecast } from './internal-meteo.ts';

function timeZoneForLongitude(lon: number): string {
  const offsetHours = longitudeOffsetHours(lon);
  if (offsetHours === 0) return 'Etc/UTC';
  const sign = offsetHours > 0 ? '-' : '+';
  return `Etc/GMT${sign}${Math.abs(offsetHours)}`;
}

function chartHour(validAt: string, frame: PointFrame | undefined, build: PinnedBuild): PublishedForecastHour {
  const read = (layer: LayerId) => {
    const cell = frame?.layers[layer];
    return cell?.status === 'valid' ? cell.value : null;
  };
  const profile = frame?.profile;
  const diagnostics = frame?.derived;
  const u10 = read('wind-10m-u'), v10 = read('wind-10m-v');
  const wind = windFromComponents(u10, v10);
  return {
    validAt,
    modelTerrainM: profile?.modelTerrainM ?? null,
    mapLift: pointMapLift(frame, build),
    surface: {
      temperatureC: read('sfc-temp-c'), dewPointC: read('sfc-dewpoint-c'),
      windSpeedMps: diagnostics?.wind10mSpeedMps ?? wind.speedMps,
      windDirectionDeg: diagnostics?.wind10mDirDeg ?? wind.directionDeg,
      windU: u10, windV: v10,
      windGustMps: read('wind-gust-10m'), precipitationMmHr: read('precip-rate'),
      capeJkg: read('cape-jkg'), pblHeightM: read('pbl-height-agl')
    },
    levels: profile?.status === 'valid' ? profile.levels : [],
    thermalTopM: read('thermal-top-msl'), thermalVelocityMps: read('thermal-velocity'),
    surfaceLclM: read('surface-lcl-msl'), effectiveCloudLimitM: diagnostics?.effectiveCloudLimitM ?? null,
    layerWind: diagnostics ? {
      meanSpeedMps: diagnostics.blMeanWindSpeedMps, meanDirectionDeg: diagnostics.blMeanWindDirDeg,
      topSpeedMps: diagnostics.blTopWindSpeedMps, topDirectionDeg: diagnostics.blTopWindDirDeg,
      surfaceToTopShearMps: diagnostics.blWindShearMps
    } : null
  };
}

type ScheduledFrame = { readonly id: string; readonly validTime: string };

/** Keep chart hours for the lifetime of one pinned point. */
export function createPointForecast(build: PinnedBuild, point: GeoPoint) {
  const layers = build.manifest.descriptors.layers;
  const gust = layers['wind-gust-10m'], precipitation = layers['precip-rate'];
  const { lat, lon } = point;
  const metadata: Omit<SiteForecast, 'hours'> = {
    model: build.manifest.model,
    site: { latitude: lat, longitude: lon, timeZone: timeZoneForLongitude(lon) },
    semantics: {
      gust: gust ? gust.timeSupport === 'interval-maximum' ? 'hourMax' : 'instant' : null,
      precipitation: precipitation ? precipitation.timeSupport === 'valid-time' ? 'instantRate' : 'windowMeanRate' : null
    }
  };
  const cache = new Map<string, { frame: PointFrame | undefined; hour: PublishedForecastHour }>();
  return (frames: readonly ScheduledFrame[], loaded: ReadonlyMap<string, PointFrame>): SiteForecast => ({
    ...metadata,
    hours: frames.map(({ id, validTime }) => {
      const frame = loaded.get(id);
      const cached = cache.get(id);
      if (cached && cached.frame === frame && cached.hour.validAt === validTime) return cached.hour;
      const hour = chartHour(validTime, frame, build);
      cache.set(id, { frame, hour });
      return hour;
    })
  });
}
