import { Map } from 'maplibre-gl';
import type { PinnedBuild } from '@av/client';
import type { LayerId } from '@av/contracts/layers';
import { RasterOverlay, type OverlayState } from './src/raster-overlay';

interface Selection { layer: LayerId; frame: string }
interface Sample extends Selection { ms: number; renders: number; pixels: number[][]; sources: number }
export interface PreviewBench {
  ready: Promise<void>;
  select(layer: LayerId, frame: string): Promise<Sample>;
  prepare(layer: LayerId, frame: string): void;
  pan(longitude: number): void;
  settled(): boolean;
  snapshot(): { displayed: Selection | null; requested: Selection | null; sources: number; sourceIds: string[]; width: number; height: number; renderer: string; frames: string[] };
}
declare global { interface Window { bench: PreviewBench } }

const build = await (await fetch('/bench/config.json')).json() as PinnedBuild;
const initial: Selection = { layer: 'usable-lift-agl', frame: build.manifest.frames[2].id };
const map = new Map({ container: 'map', style: { version: 8, sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#111111' } }] },
  center: [-100,40], zoom: 7.15, attributionControl: false, maxTileCacheSize: 16, canvasContextAttributes: { preserveDrawingBuffer: true } });
const canvas = map.getCanvas(), gl = canvas.getContext('webgl2')!;
if (!gl) throw new Error('WebGL2 is required by the benchmark');
const debug = gl.getExtension('WEBGL_debug_renderer_info');
const renderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
let state: OverlayState, render = 0, commitRender = -1;
let waiting: { selection: Selection; start: number; render: number; resolve: (sample: Sample) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | undefined;
const same = (a: Selection | null | undefined,b: Selection | null | undefined) => !!a && !!b && a.frame === b.frame && a.layer === b.layer;
const overlay = new RasterOverlay(map, location.origin, 1, next => {
  if (!same(state?.displayed,next.displayed)) commitRender = render;
  state = next;
  document.querySelector('#displayed')!.textContent = next.displayed ? `${next.displayed.layer} ${next.displayed.frame}` : 'Loading';
});

function sources() { return Object.keys(map.getStyle().sources).filter(id => id.startsWith('av-overlay-')); }
function pixels() {
  return [[0.5,0.5],[0.25,0.25],[0.25,0.75],[0.75,0.25],[0.75,0.75]].map(([x,y]) => {
    const value = new Uint8Array(4);
    gl.readPixels(Math.floor(canvas.width*x),Math.floor(canvas.height*y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,value);
    return [...value];
  });
}
function expected(selection: Selection) {
  return [selection.layer === 'usable-lift-agl' ? 40 : 200, 25 + build.manifest.frames.findIndex(frame => frame.id === selection.frame)*24];
}
function select(layer: LayerId,frame: string): Promise<Sample> {
  if (waiting) { clearTimeout(waiting.timer); waiting.reject(new Error('Superseded benchmark selection')); waiting = undefined; }
  const selection = {layer,frame};
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => { waiting = undefined; reject(new Error(`Frame did not render: ${layer} ${frame}`)); },15000);
    waiting = {selection,start:performance.now(),render,resolve,reject,timer};
    overlay.select(build,layer,frame);
    map.triggerRepaint();
  });
}
map.on('render',() => {
  render++;
  if (!waiting || !same(state.displayed,waiting.selection) || render <= commitRender + 1) return;
  const value = pixels(), color = expected(waiting.selection);
  if (value.some(pixel => Math.abs(pixel[0]-color[0]) > 3 || Math.abs(pixel[1]-color[1]) > 3)) return;
  const sample = { ...waiting.selection, ms: performance.now()-waiting.start, renders: render-waiting.render, pixels:value,sources:sources().length };
  clearTimeout(waiting.timer); waiting.resolve(sample); waiting = undefined;
});
window.bench = {
  ready: new Promise((resolve,reject) => map.once('load',() => { select(initial.layer,initial.frame).then(() => resolve(),reject); })),
  select,
  prepare(layer,frame) { (overlay as RasterOverlay & {prepare?: (layer: LayerId,frame: string) => void}).prepare?.(layer,frame); },
  pan(longitude) { map.jumpTo({ center:[longitude,40] }); },
  settled() { return !waiting && map.loaded() && map.areTilesLoaded() && !map.isMoving(); },
  snapshot() { return { displayed:state?.displayed ? {layer:state.displayed.layer,frame:state.displayed.frame} : null,requested:state?.requested ? {layer:state.requested.layer,frame:state.requested.frame} : null,sources:sources().length,sourceIds:sources(),width:canvas.width,height:canvas.height,renderer,frames:build.manifest.frames.map(frame => frame.id) }; }
};
