import { windgramScene, type WindgramView } from './scene-types.ts';
import type { WindgramView as InternalView } from './windgram-view.ts';

const scenes = new WeakMap<WindgramView, InternalView>();

/** The public handle contains metadata; private sampling and paths stay in this map. */
export function publishScene(data: InternalView): WindgramView {
  const scene: WindgramView = Object.freeze({
    [windgramScene]: true as const,
    unitSystem: data.unitSystem, timeZone: data.timeZone,
    width: data.width, height: data.height, left: data.left, top: data.top,
    plotWidth: data.plotWidth, plotHeight: data.plotHeight, bottom: data.bottom,
    columnWidth: data.columnWidth, floorM: data.floorM, topM: data.topM,
    compact: data.compact,
    hours: Object.freeze(data.hours.map(({ validAt, label, x, usableLiftTopM, thermalVelocityMps }) =>
      Object.freeze({ validAt, label, x, usableLiftTopM, thermalVelocityMps }))),
    get selectedHourIndex() { return data.selectedHourIndex; },
    set selectedHourIndex(index: number) { data.selectedHourIndex = index; },
  });
  scenes.set(scene, data);
  return scene;
}

export function sceneData(scene: WindgramView): InternalView {
  const data = scenes.get(scene);
  if (!data) throw new TypeError('Expected a scene returned by buildWindgramView');
  return data;
}
