import { afterEach, expect, it, vi } from 'vitest';
import type { PinnedBuild } from '@av/contracts/client';
import { PluginPanel } from './view';

class FakeElement {
  children: FakeElement[] = [];
  style: { background?: string } = {};
  textContent = '';
  className = '';
  value = '';
  constructor(readonly tag: string) {}
  append(...children: FakeElement[]): void { this.children.push(...children); }
  replaceChildren(...children: FakeElement[]): void { this.children = children; }
  add(option: FakeElement): void { this.children.push(option); }
  addEventListener(): void {}
}

afterEach(() => vi.unstubAllGlobals());

it('renders build-specific opaque or transparent no-lift legends and discloses diagnostics inside details', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const callbacks = { onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() };
  for (const [color, label] of [['#00000000', 'no usable lift (transparent)'], ['#55184d', 'no usable lift']]) {
    const panel = new PluginPanel(callbacks);
    const build = {
      model: 'gfs',
      manifest: { buildId: color, layers: ['usable-lift-msl', 'precip-rate'], frames: [], source: {}, method: { id: 'method' }, expiresAt: 'later' },
      maxNativeZoom: 5,
      coverage: { id: 'mask' },
      palettes: [
        { id: 'lift', units: 'm', edges: [0, 300], colors: ['#55184d'], noLiftColor: color },
        { id: 'rain', units: 'mm/h', edges: [0.1, 0.5], colors: ['#b9e5ff'], transparentBelow: 0.1, provisional: true }
      ]
    } as unknown as PinnedBuild;
    panel.renderBuild(build);
    const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
    const nodes = visit(panel.root as unknown as FakeElement);
    const row = nodes.find(element => element.className === 'av-legend-row' && element.children.some(child => child.textContent === label));
    expect(row?.children[0].style.background).toBe(color);
    expect(row?.children[1].textContent).toBe(label);
    const headings = nodes.filter(element => element.tag === 'h2').map(element => element.textContent);
    expect(headings).toContain('lift · m');
    expect(headings).not.toContain('rain · mm/h');
    expect(nodes.some(element => element.tag === 'details' && element.className === 'av-diagnostics')).toBe(true);
  }
});

it('normalizes wrapped longitudes and clears existing series when clicking a new point', () => {
  vi.stubGlobal('document', { getElementById: () => null, createElement: (tag: string) => new FakeElement(tag), head: new FakeElement('head') });
  vi.stubGlobal('Option', class extends FakeElement { constructor(text: string, value: string) { super('option'); this.textContent = text; this.value = value; } });
  const panel = new PluginPanel({ onModel: vi.fn(), onLayer: vi.fn(), onFrame: vi.fn(), onOpacity: vi.fn(), onSeries: vi.fn(), onBack: vi.fn() });
  panel.setClicked(32.9, 190);
  expect(panel.clickedPoint).toEqual({ lat: 32.9, lon: -170 });
  panel.renderSeries(
    {
      frames: [{ id: 'f003', validTime: '2026-10-30T03:00:00Z', intervalStart: '2026-10-30T00:00:00Z', intervalEnd: '2026-10-30T03:00:00Z', layers: { 'precip-rate': { value: 1, status: 'valid', support: 0, interpolated: false } } }],
      method: { id: 'dry-lenschow-pbl-1p2-v1' },
      source: {},
      coverage: { id: 'soaring-land-v1' },
      expiresAt: '2026-10-31T00:00:00Z'
    },
    ['precip-rate'],
    panel.clickedPoint!
  );
  const visit = (element: FakeElement): FakeElement[] => [element, ...element.children.flatMap(visit)];
  const series = visit(panel.root as unknown as FakeElement).find(element => element.className === 'av-series')!;
  expect(series.children).toHaveLength(1);
  panel.setClicked(40.1, 44.5);
  expect(series.children).toHaveLength(0);
});
