// Label collision avoidance and wind-barb spacing for Windgram charts.
// Consumes structured `ContourComponent` geometry directly.

import { convertQuantity, fahrenheitToCelsius, type UnitSystem } from './windgram-format.ts';
import type { TemperatureContour } from './windgram-geometry.ts';
import { cloudGlyphBounds, freezingGlyphBounds, windBarbGlyph } from './windgram-glyphs.ts';
import { resolveWindgramPresentation } from './windgram-presentation.ts';
import type { WindgramBarb, WindgramCloud, WindgramView } from './windgram-view.ts';

interface LabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

const overlaps = (a: LabelBox, b: LabelBox, padding = 0): boolean =>
  a.x < b.x + b.width + padding &&
  a.x + a.width > b.x - padding &&
  a.y < b.y + b.height + padding &&
  a.y + a.height > b.y - padding;

export interface PlacedTemperatureLabel {
  temperatureF: number;
  valueText: string;
  box: LabelBox;
  textX: number;
  textY: number;
  freezing: boolean;
}

/**
 * Computes non-overlapping label placements for each connected temperature contour component.
 */
function placeTemperatureLabels(
  view: Pick<
    WindgramView,
    'contours' | 'clouds' | 'barbs' | 'compact' | 'columnWidth' | 'left' | 'top' | 'bottom' | 'plotWidth' | 'unitSystem'
  > & Partial<Pick<WindgramView, 'presentation' | 'freezing'>>,
  cloudScale: number,
  clouds: readonly WindgramCloud[] = view.clouds,
  barbs: readonly WindgramBarb[] = view.barbs,
  system: UnitSystem = view.unitSystem,
): PlacedTemperatureLabel[] {
  const presentation = view.presentation ?? resolveWindgramPresentation({ compact: view.compact });
  const occupied: LabelBox[] = [
    ...clouds.map(c => cloudGlyphBounds(c.x, c.y, cloudScale)),
    ...(view.freezing ?? []).map(f => freezingGlyphBounds(f.x, f.y)),
  ];
  const winds = barbs.map(b => windBarbGlyph(b, presentation, system).bounds);
  const placed: PlacedTemperatureLabel[] = [];
  const displayTemp = (f: number) => convertQuantity(fahrenheitToCelsius(f), 'temperature', system)!;

  for (const contour of view.contours as readonly TemperatureContour[]) {
    for (const component of contour.components) {
      const valueText = `${Math.round(displayTemp(contour.temperatureF))}°`;
      // Arial's tabular digits plus the degree mark and 3px horizontal padding.
      const width = Math.ceil([...valueText].reduce((sum, c) => sum + (c === '°' ? 0.4 : /[-−]/.test(c) ? 0.333 : 0.556), 0) * presentation.fonts.primary + 6);
      const height = presentation.fonts.primary + 6;
      const middleX = (component.minX + component.maxX) / 2, middleY = (component.minY + component.maxY) / 2;
      // Geometry candidates cover short branches between source-hour labels and
      // provide another place on the line when the central candidate is cloudy.
      const stride = Math.max(1, Math.ceil(component.segments.length / 40));
      const anchors = [
        ...component.candidates,
        ...component.segments
          .filter((_, i) => i % stride === 0)
          .map((segment) => ({ x: (segment.x1 + segment.x2) / 2, y: (segment.y1 + segment.y2) / 2 })),
      ];
      const positions = anchors.flatMap((point) =>
        [0, -view.columnWidth * 0.24, view.columnWidth * 0.24].flatMap((offset) => {
          if (offset === 0) return [point];
          const x = point.x + offset;
          const crossings = component.segments
            .filter((segment) => segment.x1 !== segment.x2 && x >= Math.min(segment.x1, segment.x2) && x <= Math.max(segment.x1, segment.x2))
            .map((segment) => segment.y1 + ((segment.y2 - segment.y1) * (x - segment.x1)) / (segment.x2 - segment.x1))
            .sort((a, b) => Math.abs(a - point.y) - Math.abs(b - point.y));
          return crossings.length && Math.abs(crossings[0] - point.y) < 24 ? [{ x, y: crossings[0] }] : [];
        }),
      );
      positions.sort(
        (a, b) => Math.abs(a.x - middleX) + Math.abs(a.y - middleY) * 0.15 - (Math.abs(b.x - middleX) + Math.abs(b.y - middleY) * 0.15),
      );
      const boxes = positions
        .map((position) => ({ x: position.x - width / 2, y: position.y - height / 2, width, height }))
        .filter(
          (box) =>
            box.x >= view.left + 3 &&
            box.x + width <= view.left + view.plotWidth - 3 &&
            box.y >= view.top + 3 &&
            box.y + height <= view.bottom - 3 &&
            !occupied.some((other) => overlaps(box, other, 4)),
        );
      if (!boxes.length) continue;
      const box = boxes.find((candidate) => !winds.some((wind) => overlaps(candidate, wind, 1))) ??
        boxes.reduce((best, candidate) => {
          const cost = (box: LabelBox) => winds.reduce((sum, wind, i) => sum + (overlaps(box, wind, 1) ? (barbs[i].interpolated ? 1 : 2) : 0), 0);
          return cost(candidate) < cost(best) ? candidate : best;
        });
      occupied.push(box);
      placed.push({
        temperatureF: contour.temperatureF,
        valueText,
        box,
        textX: box.x + width / 2,
        textY: box.y + height / 2 + presentation.fonts.primary * 0.35,
        freezing: contour.temperatureF === 32,
      });
    }
  }
  return placed;
}

/** Thin display marks only; retain native model levels before filling large gaps. */
export function displayedBarbs(
  view: Pick<WindgramView, 'barbs' | 'compact' | 'top' | 'bottom' | 'left' | 'plotWidth' | 'unitSystem' | 'presentation'>,
  hourIndices: ReadonlySet<number>,
): WindgramBarb[] {
  const { minimumHorizontalSpacing, minimumVerticalSpacing } = view.presentation.glyphs;
  const columns = [...new Map(view.barbs.filter(b => hourIndices.has(b.hourIndex)).map(b => [b.hourIndex, b.x])).entries()]
    .sort((a, b) => a[1] - b[1]);
  const visible: WindgramBarb[] = [];
  let previousX = -Infinity;
  for (const [hourIndex, x] of columns) {
    if (x - previousX < minimumHorizontalSpacing) continue;
    const candidates = view.barbs.filter(barb => {
      if (barb.hourIndex !== hourIndex) return false;
      const box = windBarbGlyph(barb, view.presentation, view.unitSystem).bounds;
      return box.x >= view.left && box.x + box.width <= view.left + view.plotWidth &&
        box.y >= view.top && box.y + box.height <= view.bottom;
    }).sort((a, b) => Number(a.interpolated) - Number(b.interpolated) || b.y - a.y);
    const selected: WindgramBarb[] = [];
    for (const barb of candidates) {
      if (selected.every(other => Math.abs(other.y - barb.y) >= minimumVerticalSpacing)) selected.push(barb);
    }
    if (selected.length) {
      visible.push(...selected);
      previousX = x;
    }
  }
  return visible;
}

/** Reserve a clear spot for each label, hiding a colliding wind mark only as a last resort. */
export function layoutWindgramMarks(
  view: WindgramView,
  cloudScale: number,
  clouds: readonly WindgramCloud[],
  barbs: readonly WindgramBarb[],
) {
  const labels = placeTemperatureLabels(view, cloudScale, clouds, barbs);
  return {
    labels,
    barbs: barbs.filter(barb => {
      const box = windBarbGlyph(barb, view.presentation, view.unitSystem).bounds;
      return !labels.some(label => overlaps(label.box, box, 1));
    }),
  };
}
