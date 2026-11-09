import type { SiteForecast } from './internal-meteo.ts';
import type { WindgramView, WindgramOptions, WindgramReading } from './scene-types.ts';
export type { WindgramView, WindgramOptions, WindgramReading } from './scene-types.ts';
import { publishScene, sceneData } from './scene-store.ts';
import { buildWindgramView as buildView } from './windgram-view.ts';
import { readWindgram as readView } from './windgram-inspector.ts';

/** Build from a validated forecast. Retain the original scene handle for rendering and inspection. */
export function buildWindgramView(profile: SiteForecast, options: WindgramOptions): WindgramView {
  return publishScene(buildView(profile, options));
}
/** Read at metres MSL; output field names specify units and missing weather remains null. */
export function readWindgram(view: WindgramView, hourIndex: number, heightM: number): WindgramReading {
  return readView(sceneData(view), hourIndex, heightM);
}
