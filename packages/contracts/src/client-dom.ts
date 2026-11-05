import { activePalettes, buildDiagnosticRows, paletteLegend, pointFrameView, seriesTable, type UnitSystem } from './client-view.ts';
import type { PinnedBuild, SamplePayload } from './client-types.ts';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  return element;
}

export function renderBuildDiagnostics(container: HTMLElement, build: PinnedBuild): void {
  container.replaceChildren(...buildDiagnosticRows(build).flatMap(([label, value]) => {
    const detail = node('dd');
    if (label === 'Source data' && /^https?:\/\//i.test(value)) {
      const link = node('a', 'View source receipts');
      link.href = value;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      detail.append(link);
    } else detail.textContent = value;
    return [node('dt', label), detail];
  }));
}

export function renderPaletteLegend(container: HTMLElement, build: PinnedBuild, layer: string | null): void {
  const { palettes, layers } = build.manifest.descriptors;
  container.replaceChildren(...activePalettes(palettes, layer, layers).map(palette => {
    const section = node('section'), model = paletteLegend(palette);
    section.append(node('h2', model.title));
    if (model.gradient) {
      const bar = node('div'), endpoints = node('div');
      bar.className = 'av-legend-gradient';
      bar.style.background = model.gradient.background;
      bar.style.height = '16px';
      bar.role = 'img';
      bar.ariaLabel = `${model.gradient.minimum} to ${model.gradient.maximum}`;
      endpoints.className = 'av-legend-endpoints';
      endpoints.style.display = 'flex';
      endpoints.style.justifyContent = 'space-between';
      endpoints.append(node('span', model.gradient.minimum), node('span', model.gradient.maximum));
      section.append(bar, endpoints);
    }
    for (const { color, label } of model.rows) {
      const row = node('div'), swatch = node('span');
      row.className = 'av-legend-row';
      swatch.className = 'av-swatch';
      swatch.style.background = color;
      row.append(swatch, node('span', label));
      section.append(row);
    }
    if (model.note) {
      const note = node('p', model.note);
      note.className = 'av-palette-note';
      section.append(note);
    }
    return section;
  }));
}

export function renderSampleTable(container: HTMLElement, payload: Pick<SamplePayload, 'frames'>, layers: readonly string[], build: PinnedBuild): void {
  const model = seriesTable(payload, layers, build.manifest.descriptors.layers, build.manifest.version === 5 ? [] : build.manifest.patches);
  const table = node('table'), head = node('tr');
  head.append(...model.headings.map(label => node('th', label)));
  table.append(head);
  for (const cells of model.rows) {
    const row = node('tr');
    row.append(...cells.map(text => node('td', text)));
    table.append(row);
  }
  container.replaceChildren(table);
}

/** Mount one bounded series; frame/unit updates reuse its bars and cached values. */
export function renderPointSeries(
  container: HTMLElement, payload: SamplePayload, build: PinnedBuild,
  options: { frameId: string | null; unitSystem: UnitSystem; onFrame(id: string): void }
): (frameId: string | null, units?: UnitSystem) => void {
  const section = node('section'), summary = node('p'), chart = node('div'), legend = node('p'), details = node('details'), table = node('div');
  section.className = 'av-point-series'; summary.className = 'av-point-values'; chart.className = 'av-point-chart';
  chart.role = 'group'; chart.ariaLabel = 'Point forecast hours in UTC';
  summary.style.cssText = 'font-size:12px;line-height:1.6;margin:4px 0 12px';
  chart.style.cssText = 'display:flex;gap:3px;overflow-x:auto;align-items:stretch;min-height:132px;padding:3px';
  legend.style.cssText = 'font-size:11px;opacity:.75;margin:8px 0';
  legend.textContent = 'UTC · Lift blue · LCL gold · Terrain grey';
  const heading = node('summary', 'Values and source surfaces');
  heading.style.cssText = 'font-size:11px;cursor:pointer;margin:8px 0'; details.append(heading, table);
  details.addEventListener('toggle', () => {
    if (details.open && !table.children.length) renderSampleTable(table, payload, Object.keys(payload.frames[0]?.layers ?? {}), build);
  });
  const heightValues = payload.frames.flatMap(frame => {
    const view = pointFrameView(frame, build, options.unitSystem);
    return [view.terrainM, view.mslM, view.lclM].filter((value): value is number => value !== null);
  });
  const minimum = Math.min(0, ...heightValues), span = Math.max(1, ...heightValues) - minimum;
  const percent = (meters: number) => Math.min(100, Math.max(0, (meters - minimum) / span * 100));
  const bars = payload.frames.map((frame, index) => {
    const button = node('button'), plot = node('span'), hour = node('span', new Date(frame.validTime).toISOString().slice(11, 13));
    button.type = 'button'; button.value = frame.id;
    button.style.cssText = 'flex:1 0 16px;min-width:16px;padding:2px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;cursor:pointer';
    plot.style.cssText = 'display:block;position:relative;height:100px;border-bottom:1px solid #89959e';
    hour.style.cssText = 'display:block;font-size:10px;line-height:20px';
    const view = pointFrameView(frame, build, options.unitSystem);
    if (view.terrainM !== null) {
      const floor = node('span'); floor.style.cssText = `position:absolute;display:block;bottom:0;width:100%;height:${percent(view.terrainM)}%;background:#89959e55`;
      plot.append(floor);
    }
    if (view.mslM !== null) {
      const lift = node('span');
      lift.style.cssText = view.terrainM === null
        ? `position:absolute;display:block;bottom:${percent(view.mslM)}%;width:100%;height:3px;background:#229ec6`
        : `position:absolute;display:block;bottom:${percent(view.terrainM)}%;width:100%;height:${Math.max(0, percent(view.mslM) - percent(view.terrainM))}%;background:#229ec6`;
      plot.append(lift);
    }
    if (view.lclM !== null) {
      const lcl = node('span'); lcl.style.cssText = `position:absolute;display:block;bottom:${percent(view.lclM)}%;width:100%;height:2px;background:#b8860b`;
      plot.append(lcl);
    }
    button.append(plot, hour); button.addEventListener('click', () => options.onFrame(frame.id));
    button.addEventListener('keydown', event => {
      const target = event.key === 'ArrowRight' ? index + 1 : event.key === 'ArrowLeft' ? index - 1 : event.key === 'Home' ? 0 : event.key === 'End' ? payload.frames.length - 1 : -1;
      if (target < 0 || target >= payload.frames.length) return;
      event.preventDefault(); bars[target].focus(); options.onFrame(payload.frames[target].id);
    });
    chart.append(button); return button;
  });
  section.append(summary, chart, legend, details); container.replaceChildren(section);
  let units = options.unitSystem;
  const update = (frameId: string | null, nextUnits = units) => {
    units = nextUnits;
    const frame = payload.frames.find(frame => frame.id === frameId);
    const hasSelection = frame !== undefined;
    summary.textContent = frame ? pointFrameView(frame, build, units).summary : 'Selected frame is outside this point series.';
    bars.forEach((bar, index) => {
      const frame = payload.frames[index], selected = frame.id === frameId;
      bar.ariaPressed = String(selected); bar.tabIndex = selected || (!hasSelection && index === 0) ? 0 : -1;
      bar.style.borderColor = selected ? '#229ec6' : 'transparent';
      bar.ariaLabel = `${frame.validTime} · ${pointFrameView(frame, build, units).summary}`;
      bar.title = bar.ariaLabel;
    });
  };
  update(options.frameId); return update;
}
