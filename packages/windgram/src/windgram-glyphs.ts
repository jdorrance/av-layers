import { barbGeometry } from './wind-barb.ts';
import { knotsToMps, type UnitSystem } from './windgram-format.ts';
import { WINDGRAM_PRESENTATION, type WindgramPresentation } from './windgram-presentation.ts';

export interface GlyphBox { x: number; y: number; width: number; height: number }
type Point = readonly [number, number];
export const CALM_RADIUS = WINDGRAM_PRESENTATION.glyphs.calmRadius;

/** The returned scale is also the exact scale written into the SVG transform. */
export function windgramCloudScale(view: { compact: boolean; columnWidth: number; presentation: WindgramPresentation }): number {
  const scale = view.compact ? view.presentation.glyphs.cloudScale.mobile : view.presentation.glyphs.cloudScale.desktop;
  return Number(Math.max(scale.minimum, Math.min(scale.maximum, view.columnWidth / scale.columnDivisor)).toFixed(2));
}

const bounds = (points: readonly Point[], strokeWidth: number): GlyphBox => {
  const xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  const x = Math.min(...xs) - strokeWidth / 2, y = Math.min(...ys) - strokeWidth / 2;
  return { x, y, width: Math.max(...xs) + strokeWidth / 2 - x, height: Math.max(...ys) + strokeWidth / 2 - y };
};
const positioned = (box: GlyphBox, x: number, y: number, scale = 1): GlyphBox => ({
  x: x + box.x * scale, y: y + box.y * scale, width: box.width * scale, height: box.height * scale,
});

/** Bounds include every rendered feather, pennant and the outer outline. */
export function windBarbGlyph(
  barb: { x: number; y: number; speedKt: number; directionDeg: number },
  presentation: WindgramPresentation,
  system: UnitSystem,
) {
  const geometry = barbGeometry(system === 'metric' ? knotsToMps(barb.speedKt) * 2 : barb.speedKt, barb.directionDeg, presentation.glyphs.barbStaff);
  const local = geometry.calm
    ? bounds([[-CALM_RADIUS, -CALM_RADIUS], [CALM_RADIUS, CALM_RADIUS]], WINDGRAM_PRESENTATION.strokes.barbRim)
    : geometry.points.length ? bounds(geometry.points, WINDGRAM_PRESENTATION.strokes.barbRim) : { x: 0, y: 0, width: 0, height: 0 };
  return { ...geometry, bounds: positioned(local, barb.x, barb.y) };
}

// The flat bottom is the indicated cloud base; every lobe is above it.
const cloudCurves: readonly (readonly [Point, Point, Point, Point])[] = [
  [[-20, 0], [-27, 0], [-28, -10], [-20, -13]],
  [[-20, -13], [-20, -21], [-8, -24], [-3, -17]],
  [[-3, -17], [4, -28], [19, -23], [20, -14]],
  [[20, -14], [30, -14], [32, 0], [22, 0]],
];
export const CLOUD_PATH = `M${cloudCurves[0][0].join(' ')}${cloudCurves.map(curve => `C${curve.slice(1).flat().join(' ')}`).join('')}Z`;
export const SNOWFLAKE_PATH = 'M-4 0H4M-2-3.46L2 3.46M-2 3.46L2-3.46';

/** Sample each cubic's endpoints and interior extrema. */
function cubicExtrema(curve: readonly [Point, Point, Point, Point]): Point[] {
  const times = new Set([0, 1]);
  for (const axis of [0, 1]) {
    const [p0, p1, p2, p3] = curve.map(p => p[axis]);
    const a = -p0 + 3 * p1 - 3 * p2 + p3, b = 2 * (p0 - 2 * p1 + p2), c = p1 - p0;
    if (Math.abs(a) < 1e-12) {
      if (Math.abs(b) > 1e-12) { const t = -c / b; if (t > 0 && t < 1) times.add(t); }
    } else {
      const d = b * b - 4 * a * c;
      if (d >= 0) for (const t of [(-b - Math.sqrt(d)) / (2 * a), (-b + Math.sqrt(d)) / (2 * a)]) if (t > 0 && t < 1) times.add(t);
    }
  }
  return [...times].map(t => {
    const at = (axis: number) => (1 - t) ** 3 * curve[0][axis] + 3 * (1 - t) ** 2 * t * curve[1][axis] +
      3 * (1 - t) * t ** 2 * curve[2][axis] + t ** 3 * curve[3][axis];
    return [at(0), at(1)] as const;
  });
}
const cloudBounds = bounds(cloudCurves.flatMap(cubicExtrema), WINDGRAM_PRESENTATION.strokes.cloud);
const freezingBounds = bounds([[-4, -3.46], [4, 3.46]], WINDGRAM_PRESENTATION.strokes.freezingMark);
export const cloudGlyphBounds = (x: number, y: number, scale: number) => positioned(cloudBounds, x, y, scale);
export const freezingGlyphBounds = (x: number, y: number) => positioned(freezingBounds, x, y);
