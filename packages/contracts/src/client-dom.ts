import { activePalettes, buildDiagnosticRows, paletteLegend, seriesTable } from './client-view.ts';
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
  const model = seriesTable(payload, layers, build.manifest.descriptors.layers, build.manifest.patches);
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
