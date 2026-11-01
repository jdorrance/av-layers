import { type LayerId } from '@av/contracts';
import {
  activePalettes,
  buildDiagnosticRows,
  coverageSummaryText,
  formatSeriesSummary,
  normalizePoint,
  paletteLegend,
  seriesTable,
  populateModelOptions,
  type FrameSample,
  type GeoPoint,
  type PinnedBuild
} from '@av/contracts/client';
import type { ControllerState } from './controller';

export interface PanelCallbacks {
  onModel(model: string): void;
  onLayer(layer: LayerId): void;
  onFrame(frame: string): void;
  onOpacity(opacity: number): void;
  onSeries(): void;
  onBack(): void;
}

const STYLE_ID = 'av-windy-plugin-style';
const CSS = `
.av-panel{position:fixed;top:10px;right:10px;z-index:99999;width:min(360px,calc(100vw - 20px));max-height:calc(100vh - 20px);overflow:auto;padding:14px;background:#13191cf2;color:#e6edf0;border:1px solid #36464d;border-radius:8px;box-shadow:0 8px 28px #0008;font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
.av-panel[hidden]{display:none}
.av-header{display:flex;align-items:center;justify-content:space-between;gap:8px}
.av-header h1{margin:0;font-size:15px}
.av-back,.av-button{padding:5px 8px;border:0;border-radius:4px;background:#1c6b8a;color:#fff;cursor:pointer;font-size:12px}
.av-button:disabled{opacity:.45;cursor:default}
.av-muted{color:#8fa4ad;font-size:11px;margin:6px 0}
.av-controls{display:grid;grid-template-columns:62px 1fr;gap:6px 8px;align-items:center;margin:8px 0;font-size:12px}
.av-controls select,.av-controls input{width:100%;min-width:0;background:#0e1113;color:#e6edf0;border:1px solid #36464d;border-radius:4px;padding:4px}
.av-badge{margin:8px 0;padding:5px 7px;background:#1d2b31;border:1px solid #2f444d;border-radius:4px;font-size:11px}
.av-error{margin:6px 0;padding:6px 8px;background:#2a1414;border:1px solid #7e2f2f;color:#ffb4b4;border-radius:4px;font-size:11px}
.av-warning{margin:6px 0;padding:6px 8px;background:#302613;border:1px solid #79622f;color:#ffdc91;border-radius:4px;font-size:11px}
.av-diagnostics{margin-top:12px;border-top:1px solid #253036;padding-top:8px}
.av-diagnostics summary{cursor:pointer;color:#8fa4ad;font-size:11px;font-weight:600;margin-bottom:6px}
.av-meta{display:grid;grid-template-columns:76px 1fr;gap:3px 8px;margin:8px 0;font-size:10.5px}
.av-meta dt{color:#8fa4ad}.av-meta dd{margin:0;word-break:break-word}.av-meta a{color:#9bdcff}
.av-panel h2{margin:10px 0 5px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8fa4ad}
.av-legend-row{display:flex;align-items:center;gap:6px;font-size:10.5px;min-height:16px}
.av-swatch{width:22px;height:11px;border-radius:2px;border:1px solid #ffffff22;flex:none}
.av-series-panel{margin-top:12px;border-top:1px solid #253036;padding-top:8px}
.av-series table{width:100%;border-collapse:collapse;font-size:9px;margin-top:6px}
.av-series th,.av-series td{padding:2px 3px;border-bottom:1px solid #253036;text-align:left;white-space:nowrap}
.av-series th{color:#8fa4ad}
`;

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
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
  readonly root: HTMLDivElement;
  private readonly modelSelect = node('select');
  private readonly layerSelect = node('select');
  private readonly frameSelect = node('select');
  private readonly opacityInput = node('input');
  private readonly badge = node('p', 'av-badge');
  private readonly status = node('p', 'av-muted');
  private readonly coverage = node('p', 'av-muted');
  private readonly meta = node('dl', 'av-meta');
  private readonly legend = node('div', 'av-legend');
  private readonly error = node('p', 'av-error');
  private readonly horizonNotice = node('p', 'av-warning');
  private readonly seriesStatus = node('p', 'av-muted');
  private readonly series = node('div', 'av-series');
  private readonly seriesButton = node('button', 'av-button', 'Sample clicked point');
  private renderedBuildId: string | null = null;
  private renderedLegend: { buildId: string; layer: string | null; palettes: PinnedBuild['palettes'] } | null = null;
  private currentBuild: PinnedBuild | null = null;
  private clicked: GeoPoint | null = null;

  constructor(callbacks: PanelCallbacks) {
    ensureStyles();
    this.root = node('div', 'av-panel');
    const header = node('header', 'av-header');
    const title = node('h1', undefined, 'AV usable lift');
    const back = node('button', 'av-back', '← Menu');
    back.type = 'button';
    back.addEventListener('click', callbacks.onBack);
    header.append(title, back);
    populateModelOptions(this.modelSelect);
    this.modelSelect.addEventListener('change', () => callbacks.onModel(this.modelSelect.value));
    this.layerSelect.addEventListener('change', () => {
      if (this.currentBuild) this.renderLegend(this.currentBuild, this.layerSelect.value);
      callbacks.onLayer(this.layerSelect.value as LayerId);
    });
    this.frameSelect.addEventListener('change', () => callbacks.onFrame(this.frameSelect.value));
    this.opacityInput.type = 'range';
    this.opacityInput.min = '0';
    this.opacityInput.max = '1';
    this.opacityInput.step = '0.05';
    this.opacityInput.value = '0.5';
    this.opacityInput.addEventListener('input', () => callbacks.onOpacity(Number(this.opacityInput.value)));
    this.seriesButton.type = 'button';
    this.seriesButton.disabled = true;
    this.seriesButton.addEventListener('click', callbacks.onSeries);
    this.error.hidden = true;
    this.horizonNotice.hidden = true;
    const controls = node('div', 'av-controls');
    controls.append(
      node('label', undefined, 'Model'),
      this.modelSelect,
      node('label', undefined, 'Layer'),
      this.layerSelect,
      node('label', undefined, 'Frame'),
      this.frameSelect,
      node('label', undefined, 'Opacity'),
      this.opacityInput
    );
    const seriesPanel = node('section', 'av-series-panel');
    seriesPanel.append(node('h2', undefined, 'Point series'), this.seriesStatus, this.seriesButton, this.series);
    const diagnostics = node('details', 'av-diagnostics');
    diagnostics.append(node('summary', undefined, 'Build & method diagnostics'), this.meta);
    this.root.append(header, this.status, this.horizonNotice, controls, this.badge, this.error, this.coverage, this.legend, seriesPanel, diagnostics);
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setStatus(text: string): void {
    this.status.textContent = text;
  }

  setError(message: string | null): void {
    this.error.hidden = message === null;
    this.error.textContent = message ?? '';
  }

  setSeriesStatus(text: string): void {
    this.seriesStatus.textContent = text;
  }

  clearSeries(): void {
    this.series.replaceChildren();
    this.setSeriesStatus('');
  }

  setClicked(lat: number, lon: number): void {
    this.series.replaceChildren();
    this.clicked = normalizePoint(lat, lon);
    this.seriesButton.disabled = false;
    this.seriesStatus.textContent = `Clicked ${this.clicked.lat.toFixed(4)}, ${this.clicked.lon.toFixed(4)}`;
  }

  get clickedPoint(): GeoPoint | null {
    return this.clicked;
  }

  setSeriesEnabled(enabled: boolean): void {
    this.seriesButton.disabled = !enabled || !this.clicked;
  }

  renderBuild(build: PinnedBuild): void {
    const key = `${build.model}:${build.manifest.buildId}`;
    this.currentBuild = build;
    if (this.renderedBuildId === key) {
      this.renderLegend(build, this.layerSelect.value);
      return;
    }
    this.renderedBuildId = key;
    this.modelSelect.value = build.model;
    this.layerSelect.replaceChildren(...build.manifest.layers.map(layer => new Option(build.manifest.descriptors.layers[layer].label, layer)));
    this.layerSelect.value = build.manifest.layers[0] ?? '';
    this.frameSelect.replaceChildren(...build.manifest.frames.map(frame => new Option(`${frame.id} · ${frame.validTime}`, frame.id)));
    this.coverage.textContent = coverageSummaryText(build);
    const rows = Array.isArray(build.bounds) && build.manifest.grid && build.manifest.method?.hash
      ? buildDiagnosticRows(build)
      : [
          ['Build', build.manifest.buildId],
          ['Method', build.manifest.method?.id ?? 'unknown'],
          ['Expires', build.manifest.expiresAt]
        ];
    this.meta.replaceChildren(...rows.flatMap(([label, value]) => {
      const detail = node('dd');
      if (label === 'Provenance' && /^https?:\/\//i.test(value)) {
        const link = node('a', undefined, value);
        link.href = value;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        detail.append(link);
      } else detail.textContent = value;
      return [node('dt', undefined, label), detail];
    }));
    this.renderLegend(build, this.layerSelect.value);
  }

  private renderLegend(build: PinnedBuild, activeLayer: string | null): void {
    const buildId = `${build.model}:${build.manifest.buildId}`;
    const palettes = activePalettes(build.palettes, activeLayer, build.manifest.descriptors.layers);
    const previous = this.renderedLegend;
    if (previous?.buildId === buildId && previous.layer === activeLayer &&
      previous.palettes.length === palettes.length && previous.palettes.every((palette, index) => palette === palettes[index])) return;
    this.renderedLegend = { buildId, layer: activeLayer, palettes };
    this.legend.replaceChildren();
    for (const palette of palettes) {
      const section = node('section');
      const model = paletteLegend(palette);
      section.append(node('h2', undefined, model.title));
      model.rows.forEach(({ color, label }) => {
        const row = node('div', 'av-legend-row');
        const swatch = node('span', 'av-swatch');
        swatch.style.background = color;
        row.append(swatch, node('span', undefined, label));
        section.append(row);
      });
      const noteText = model.note;
      if (noteText) section.append(node('p', 'av-muted', noteText));
      this.legend.append(section);
    }
  }

  renderState(state: ControllerState): void {
    this.badge.textContent = state.badge;
    this.setError(state.message);
    this.horizonNotice.hidden = state.horizonNotice === null;
    this.horizonNotice.textContent = state.horizonNotice ?? '';
    if (state.frameId) this.frameSelect.value = state.frameId;
    if (state.layerId) {
      this.layerSelect.value = state.layerId;
      if (this.currentBuild) this.renderLegend(this.currentBuild, state.layerId);
    }
    this.opacityInput.value = String(state.opacity);
    const usable = state.phase === 'ready';
    this.modelSelect.disabled = !usable;
    this.layerSelect.disabled = !usable;
    this.frameSelect.disabled = !usable;
    this.opacityInput.disabled = !usable;
    this.setSeriesEnabled(usable);
    if (state.phase === 'loading') this.setStatus('Loading latest immutable build…');
    if (state.phase === 'expired') this.setStatus('Expired build — overlay removed');
    if (state.phase === 'ready' && state.buildId) this.setStatus(`Pinned build ${state.buildId}`);
    if (state.phase === 'error') this.setStatus('No viewable build');
  }

  renderSeries(
    payload: { frames: FrameSample[]; method: unknown; source: unknown; coverage: unknown; expiresAt: string },
    layers: string[],
    point?: GeoPoint
  ): void {
    const table = node('table');
    const head = node('tr');
    const model = seriesTable(payload, layers, this.currentBuild?.manifest.descriptors.layers);
    for (const label of model.headings) {
      head.append(node('th', undefined, label));
    }
    table.append(head);
    for (const cells of model.rows) {
      const row = node('tr');
      for (const text of cells) row.append(node('td', undefined, text));
      table.append(row);
    }
    this.series.replaceChildren(table);
    const targetPoint = point ?? this.clicked ?? { lat: 0, lon: 0 };
    this.seriesStatus.textContent = formatSeriesSummary(payload, layers, targetPoint);
  }
}
