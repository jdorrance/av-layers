import type { WindgramView } from './scene.ts';
import { sceneData } from './scene-store.ts';
import { chartStyles } from './chart-styles.ts';
import { mountWindgram as mount, type WindgramMountOptions } from './windgram-dom.ts';

export type WindgramMount = ReturnType<typeof mountWindgram>;

/** Mount a chart and install its stylesheet in the host document. */
export function mountWindgram(host: HTMLElement, options: WindgramMountOptions & { view: WindgramView }) {
  const owner = host.ownerDocument ?? document;
  const styleId = 'av-windgram-chart-style';
  if (owner.head && !owner.getElementById?.(styleId)) {
    const style = owner.createElement('style');
    style.id = styleId;
    style.textContent = chartStyles;
    owner.head.append(style);
  }
  const chart = mount(host, { ...options, view: sceneData(options.view) });
  return { update: (view: WindgramView) => chart.update(sceneData(view)), select: chart.select, setMode: chart.setMode, dispose: chart.dispose };
}
