import { DEFAULT_OPACITY, populateModelOptions, pointSeriesLabel, pointSeriesSelection, type PinnedBuild, type GeoPoint, type PointSeries, type PointHorizon, type UnitSystem } from '@av/contracts/client';
import { renderPointSeries } from '@av/contracts/client/dom';
import type { ControllerState } from './controller';
import config from './pluginConfig';

export interface PanelCallbacks {
  onModel(model: string): void;
  onOpacity(opacity: number): void;
  onBack(): void;
  onPointHorizon(horizon: PointHorizon): void;
}

const STYLE_ID = 'av-windy-plugin-style';
const CSS = `
.av-panel,.av-panel *{box-sizing:border-box}
.av-panel{color:#e6edf0;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.av-panel[hidden],.av-mobile-header[hidden]{display:none}
.av-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.av-header h1{margin:0;font-size:15px}
.av-back{padding:5px 8px;border:0;border-radius:4px;background:#1c6b8a;color:#fff;cursor:pointer;font-size:12px}
.av-muted{color:#8fa4ad;font-size:11px;margin:6px 0}
.av-controls{display:grid;grid-template-columns:62px 1fr auto;gap:6px 8px;align-items:center;margin:8px 0;font-size:12px}
.av-controls select,.av-controls input{width:100%;min-width:0;background:#0e1113;color:#e6edf0;border:1px solid #36464d;border-radius:4px;padding:4px}
.av-readout{min-width:36px;text-align:right;font-variant-numeric:tabular-nums;color:#e6edf0}
.av-notice{margin:6px 0;padding:6px 8px;background:#14202a;border:1px solid #2f4a5c;color:#d5e7ef;border-radius:4px;font-size:11px}
.av-error{margin:6px 0;padding:6px 8px;background:#2a1414;border:1px solid #7e2f2f;color:#ffb4b4;border-radius:4px;font-size:11px}
.av-warning{margin:6px 0;padding:6px 8px;background:#302613;border:1px solid #79622f;color:#ffdc91;border-radius:4px;font-size:11px}
`;

function ensureStyles(): void {
  const style = document.getElementById(STYLE_ID) ?? document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.append(style);
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export class PluginPanel {
  readonly root: HTMLElement;
  readonly mobileHeader: HTMLDivElement;
  private readonly modelSelect = node('select');
  private readonly opacityInput = node('input');
  private readonly opacityReadout = node('span', 'av-readout', '50%');
  private readonly status = node('p', 'av-muted');
  private readonly notice = node('p', 'av-notice');
  private readonly error = node('p', 'av-error');
  private readonly horizonNotice = node('p', 'av-warning');
  private readonly point = node('section', 'av-point');
  private readonly pointTitle = node('p', 'av-muted');
  private readonly pointStatus = node('p', 'av-muted');
  private readonly pointBody = node('div');
  private readonly units = node('select');
  private readonly pointHorizon = node('select');
  private readonly pointHorizonLabel = node('label', undefined, 'Point horizon');
  private unitSystem: UnitSystem = 'metric';
  private pointFrameId: string | null = null;
  private selectedFrameId: string | null = null;
  private mapFrameId: string | null = null;
  private updatePoint: ReturnType<typeof renderPointSeries> | null = null;
  private renderedBuildId: string | null = null;

  constructor(callbacks: PanelCallbacks) {
    ensureStyles();
    this.root = node('section', 'plugin__content av-panel');
    this.mobileHeader = node('div', 'plugin__mobile-header av-mobile-header', config.title);
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' && event.key !== 'Tab') event.stopPropagation();
    });
    const header = node('header', 'plugin__title av-header');
    const back = node('button', 'av-back', '← Menu');
    back.type = 'button';
    back.addEventListener('click', callbacks.onBack);
    header.append(node('h1', undefined, config.title), back);
    populateModelOptions(this.modelSelect);
    this.modelSelect.id = 'av-model';
    this.modelSelect.addEventListener('change', () => callbacks.onModel(this.modelSelect.value));
    this.opacityInput.id = 'av-opacity';
    this.opacityInput.type = 'range';
    this.opacityInput.min = '0';
    this.opacityInput.max = '1';
    this.opacityInput.step = '0.01';
    this.opacityInput.value = String(DEFAULT_OPACITY);
    this.opacityInput.addEventListener('input', () => {
      const opacity = Number(this.opacityInput.value);
      this.opacityReadout.textContent = percent(opacity);
      callbacks.onOpacity(opacity);
    });
    this.notice.hidden = true;
    this.notice.role = 'status';
    this.error.hidden = true;
    this.error.role = 'alert';
    this.horizonNotice.hidden = true;
    this.horizonNotice.role = 'status';
    const controls = node('div', 'av-controls');
    const modelLabel = node('label', undefined, 'Model');
    modelLabel.htmlFor = this.modelSelect.id;
    const opacityLabel = node('label', undefined, 'Opacity');
    opacityLabel.htmlFor = this.opacityInput.id;
    controls.append(modelLabel, this.modelSelect, node('span'), opacityLabel, this.opacityInput, this.opacityReadout);
    this.units.id = 'av-units';
    this.units.add(new Option('m · m/s', 'metric')); this.units.add(new Option('ft · kt', 'imperial'));
    this.units.value = this.unitSystem;
    const unitsLabel = node('label', undefined, 'Units'); unitsLabel.htmlFor = this.units.id;
    this.units.addEventListener('change', () => {
      this.unitSystem = this.units.value === 'imperial' ? 'imperial' : 'metric';
      this.updatePoint?.(this.pointFrameId, this.unitSystem, this.mapFrameId);
    });
    this.pointHorizon.id = 'av-point-horizon';
    this.pointHorizon.add(new Option('Map forecast', 'day')); this.pointHorizon.add(new Option('Full forecast', 'forecast'));
    this.pointHorizon.value = 'day';
    this.pointHorizonLabel.htmlFor = this.pointHorizon.id;
    this.pointHorizon.addEventListener('change', () => callbacks.onPointHorizon(this.pointHorizon.value === 'forecast' ? 'forecast' : 'day'));
    this.point.hidden = true;
    this.point.style.cssText = 'margin-top:12px;border-top:1px solid #36464d;padding-top:8px';
    this.pointStatus.role = 'status';
    this.point.append(this.pointTitle, this.pointStatus, unitsLabel, this.units, this.pointHorizonLabel, this.pointHorizon, this.pointBody);
    this.root.append(header, this.status, this.horizonNotice, controls, this.notice, this.error, this.point);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    this.mobileHeader.hidden = !visible;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setNotice(message: string | null): void {
    this.notice.hidden = message === null;
    this.notice.textContent = message ?? '';
  }

  setError(message: string | null): void {
    this.error.hidden = message === null;
    this.error.textContent = message ?? '';
  }

  renderBuild(build: PinnedBuild): void {
    const key = `${build.manifest.model}:${build.manifest.buildId}`;
    if (this.renderedBuildId === key) return;
    this.renderedBuildId = key;
    this.modelSelect.value = build.manifest.model;
    this.pointHorizonLabel.hidden = this.pointHorizon.hidden = pointSeriesSelection(build).frames.length === build.manifest.frames.length;
    this.pointHorizon.children[0].textContent = build.manifest.version === 5 && build.manifest.mapFrameCount !== undefined ? 'Map forecast' : '24 hours';
  }

  renderState(state: ControllerState): void {
    this.setError(state.message);
    this.setNotice(state.notice);
    this.horizonNotice.hidden = state.horizonNotice === null;
    this.horizonNotice.textContent = state.horizonNotice ?? '';
    if (document.activeElement !== this.opacityInput) {
      this.opacityInput.value = String(state.opacity);
      this.opacityReadout.textContent = percent(state.opacity);
    }
    this.modelSelect.disabled = state.phase === 'disposed';
    this.opacityInput.disabled = state.phase === 'disposed' || state.phase === 'expired';
    if (state.phase === 'loading') this.setStatus('Loading latest immutable build…');
    if (state.phase === 'expired') this.setStatus('Expired build — overlay removed');
    if (state.phase === 'ready' && state.buildId) this.setStatus(`Pinned build ${state.buildId}`);
    if (state.phase === 'error') this.setStatus('No viewable build');
    if (state.phase === 'ready') {
      if (state.frameId !== null && this.selectedFrameId !== state.frameId) this.pointFrameId = state.frameId;
      this.selectedFrameId = state.frameId;
      this.mapFrameId = state.displayedFrameId;
      this.updatePoint?.(this.pointFrameId, this.unitSystem, this.mapFrameId);
    }
    if (state.phase === 'expired' || state.phase === 'disposed' || state.phase === 'error') this.clearPoint();
  }

  loadPoint(point: GeoPoint): void {
    this.clearPoint(); this.point.hidden = false;
    this.pointTitle.textContent = `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`;
    this.pointStatus.textContent = 'Loading point…';
  }

  pointLoading(frameId: string | null): void { this.pointFrameId = frameId; this.pointStatus.textContent = 'Loading point forecast…'; }

  get pointFrame(): string | null { return this.pointFrameId; }

  renderPoint(payload: PointSeries, build: PinnedBuild, frameId: string | null, onFrame: (id: string) => void, totalFrames = payload.frames.length): void {
    if (this.pointFrameId === null || (payload.frames.length === totalFrames && !payload.frames.some(frame => frame.id === this.pointFrameId))) this.pointFrameId = payload.frames.some(frame => frame.id === frameId) ? frameId : payload.frames[0]?.id ?? null;
    this.pointStatus.textContent = pointSeriesLabel(payload, totalFrames);
    this.updatePoint = renderPointSeries(this.pointBody, payload, build, { frameId: this.pointFrameId, mapFrameId: this.mapFrameId, unitSystem: this.unitSystem, totalFrames, onFrame: id => {
      this.pointFrameId = id;
      this.updatePoint?.(id, this.unitSystem, this.mapFrameId);
      onFrame(id);
    } });
  }

  pointError(message: string): void {
    this.updatePoint?.(this.pointFrameId, this.unitSystem, this.mapFrameId, false);
    this.pointStatus.textContent = message;
  }

  clearPoint(): void {
    this.updatePoint = null; this.pointFrameId = null; this.point.hidden = true;
    this.pointBody.replaceChildren(); this.pointStatus.textContent = '';
  }
}

function percent(opacity: number): string {
  return `${Math.round(opacity * 100)}%`;
}
