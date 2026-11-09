// Physical readings at an hour and height, with published diagnostic context.

import { windFromComponents } from '@av/soaring';
import {
  celsiusToFahrenheit,
  clamp,
  mpsToKnots,
  finiteScalar,
} from './windgram-format.ts';
import { sampleHeight } from './windgram-sampling.ts';
import type { WindgramView } from './windgram-view.ts';

import type { WindgramReading } from './scene-types.ts';
export type { WindgramReading } from './scene-types.ts';

function windShearAtHeight(sample: WindgramView['sampling'][number] | undefined, heightM: number): WindgramReading['windShear'] {
  if (!sample || sample.windU.length < 2 || heightM < sample.windU[0].altitudeM || heightM > sample.windU.at(-1)!.altitudeM) return null;
  const upper = sample.windU.findIndex(node => node.altitudeM > heightM);
  const index = upper < 0 ? sample.windU.length - 2 : upper - 1;
  const a = sample.windU[index], b = sample.windU[index + 1], av = sample.windV[index], bv = sample.windV[index + 1];
  if (!a || !b || !av || !bv || b.altitudeM <= a.altitudeM || ![a.value, b.value, av.value, bv.value].every(Number.isFinite)) return null;
  const vectorChangeMps = Math.hypot(b.value - a.value, bv.value - av.value);
  return { lowerM: a.altitudeM, upperM: b.altitudeM, vectorChangeMps, perKmMps: vectorChangeMps * 1000 / (b.altitudeM - a.altitudeM) };
}
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  const index = clamp(Math.round(hourIndex), 0, view.hours.length - 1);
  const sample = view.sampling[index];
  const z = clamp(heightM, view.floorM, view.topM);
  const t = sample ? sampleHeight(sample.temperatureC, z) : null;
  const dewPointC = sample ? sampleHeight(sample.dewPointC, z) : null;
  const u = sample ? sampleHeight(sample.windU, z) : null, v = sample ? sampleHeight(sample.windV, z) : null;
  const wind = windFromComponents(u, v);
  const cloud = view.clouds.find(
    (c) => c.hourIndex === index && (c.kind === 'potential' ? Math.abs(z - c.baseM) < 25 : z >= c.baseM && z <= c.topM),
  );
  const source = view.sourceHours[index];
  const omega = sample ? sampleHeight(sample.verticalVelocityPaS, z) : null;
  const nativeWind = wind.speedMps !== null && sample?.windU.some(n => Math.abs(n.altitudeM - z) < .00001 && Number.isFinite(n.value));
  const surface = source?.surface;
  const pblDepthM = surface?.pblHeightM ?? null;
  const modelTerrainM = source?.modelTerrainM ?? null;
  const fineTerrainM = source?.mapLift.terrainM ?? null;
  const groundM = fineTerrainM ?? modelTerrainM;
  return {
    hourIndex: index,
    validAt: view.hours[index]?.validAt ?? '',
    heightM: z,
    heightAglM: groundM === null || z < groundM ? null : z - groundM,
    heightAglReference: fineTerrainM !== null ? 'terrain' : modelTerrainM !== null ? 'model' : null,
    temperatureF: t === null ? null : celsiusToFahrenheit(t),
    speedKt: wind.speedMps === null ? null : mpsToKnots(wind.speedMps),
    directionDeg: wind.directionDeg,
    gustKt: view.hours[index]?.gustKt ?? null,
    cloud: cloud?.kind ?? null,
    dewPointC,
    relativeHumidityPercent: sample ? sampleHeight(sample.relativeHumidityPercent, z) : null,
    verticalVelocityPaS: omega,
    windSource: wind.speedMps === null ? null : !nativeWind ? 'interpolated'
      : modelTerrainM !== null && Math.abs(z - modelTerrainM - 10) < .00001 ? 'surface-10m' : 'model-level',
    windShear: windShearAtHeight(sample, z),
    verticalVelocitySource: omega === null ? null : sample?.verticalVelocityPaS.some(n => Math.abs(n.altitudeM - z) < .00001) ? 'model-level' : 'interpolated',
    verticalVelocityUnavailableReason: omega === null ? 'Vertical motion unavailable at this height.' : null,
    surfaceWindSpeedMps: finiteScalar(surface?.windSpeedMps),
    surfaceWindDirectionDeg: finiteScalar(surface?.windDirectionDeg),
    precipitationMmHr: finiteScalar(surface?.precipitationMmHr),
    capeJkg: finiteScalar(surface?.capeJkg),
    cloudBaseM: source?.surfaceLclM ?? null,
    effectiveCloudLimitM: source?.effectiveCloudLimitM ?? null,
    modelTerrainM,
    nativeThermalTopM: source?.thermalTopM ?? null,
    modelPblTopM: pblDepthM === null || modelTerrainM === null ? null : modelTerrainM + pblDepthM,
    publishedLayerWind: source?.layerWind ?? null,
  };
}
