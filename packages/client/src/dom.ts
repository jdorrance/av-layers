import { activePalettes, buildDiagnosticRows, paletteLegend } from './client-view.ts';
import type { PinnedBuild } from './client-types.ts';

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
