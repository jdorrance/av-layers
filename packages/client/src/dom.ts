import { buildDiagnosticRows } from './client-view.ts';
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
