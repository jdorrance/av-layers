import type { WindgramView } from './model.ts';
import { sceneData } from './scene-store.ts';
import type { WindgramSvgOptions } from './scene-types.ts';
import { renderWindgramSvg as renderSvg } from './windgram-chart.ts';
import { chartStyles } from './chart-styles.ts';
export { renderWindgramKey } from './windgram-chart.ts';

export function renderWindgramSvg(view: WindgramView, options: WindgramSvgOptions = {}): string {
  return renderSvg(sceneData(view), { ...options, stylesheet: chartStyles });
}
