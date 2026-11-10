// Windgram stability isoband field geometry and structured temperature contours.
// Keeps the stability interval-field contract and temperature point-isotherm
// contract distinct and returns connected contour components and label candidates.

import type { HourSampling } from './internal-meteo.ts';
import {
  celsiusToFahrenheit,
  convertQuantity,
  type UnitSystem,
} from './windgram-format.ts';
import { crossings, sampleField, sampleHeight, type Point } from './windgram-sampling.ts';
import { heightToY, yToHeight, type WindgramScale } from './windgram-scale.ts';
import { hourX } from './windgram-time-axis.ts';

interface ContourSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface ContourComponent {
  segments: ContourSegment[];
  candidates: Point[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface TemperatureContour {
  temperatureF: number;
  path: string;
  labels: { x: number; y: number }[];
  segments: ContourSegment[];
  components: ContourComponent[];
}

const round = (n: number) => Math.round(n * 100) / 100;
const contourPointKey = (x: number, y: number) => `${Math.round(x * 100)},${Math.round(y * 100)}`;

function closestOnSegment(point: Point, segment: ContourSegment): Point {
  const dx = segment.x2 - segment.x1, dy = segment.y2 - segment.y1;
  const lengthSquared = dx * dx + dy * dy;
  const fraction = lengthSquared
    ? Math.max(0, Math.min(1, ((point.x - segment.x1) * dx + (point.y - segment.y1) * dy) / lengthSquared))
    : 0;
  return { x: segment.x1 + fraction * dx, y: segment.y1 + fraction * dy };
}

/**
 * Groups marching-square contour segments into connected components by shared
 * rounded endpoints (preserving existing connectivity tolerance) and attaches
 * physical crossing label candidates within 6 px (`distanceSquared <= 36`).
 */
function buildContourComponentsFromSegments(
  segments: readonly ContourSegment[],
  labels: readonly Point[],
): ContourComponent[] {
  const parent = segments.map((_, i) => i);
  const root = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const endpoint = new Map<string, number>();
  segments.forEach((segment, i) => {
    for (const key of [contourPointKey(segment.x1, segment.y1), contourPointKey(segment.x2, segment.y2)]) {
      const previous = endpoint.get(key);
      if (previous !== undefined) parent[root(i)] = root(previous);
      else endpoint.set(key, i);
    }
  });
  const groups = new Map<number, ContourComponent>();
  segments.forEach((segment, i) => {
    const id = root(i);
    let group = groups.get(id);
    if (!group) {
      group = { segments: [], candidates: [], minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
      groups.set(id, group);
    }
    group.segments.push(segment);
    group.minX = Math.min(group.minX, segment.x1, segment.x2);
    group.maxX = Math.max(group.maxX, segment.x1, segment.x2);
    group.minY = Math.min(group.minY, segment.y1, segment.y2);
    group.maxY = Math.max(group.maxY, segment.y1, segment.y2);
  });
  const components = [...groups.values()];
  for (const candidate of labels) {
    let nearest: { component: ContourComponent; point: Point; distanceSquared: number } | null = null;
    for (const component of components) {
      for (const segment of component.segments) {
        const point = closestOnSegment(candidate, segment);
        const distanceSquared = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
        if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { component, point, distanceSquared };
      }
    }
    // Physical crossing candidates can differ slightly from the sampled line;
    // keep each label on its own branch and hour column.
    if (nearest && nearest.distanceSquared <= 36) nearest.component.candidates.push(nearest.point);
  }
  return components;
}

/**
 * Gap-preserving classified field path generator for Windgram stability bands.
 * Keeps missing vertical intervals (NaN nodes) open and keeps missing intervals
 * in one hour separate from adjacent hours.
 */
export function buildStabilityFieldPaths(args: {
  nodesByHour: readonly (readonly { distanceFromBottomPx: number; value: number }[])[];
  hours: readonly { x: number }[];
  columnWidth: number;
  plotTop: number;
  plotBottom: number;
  banding: { breakpoints: readonly number[]; classNames: readonly string[] };
}): Record<string, string> {
  const hourCount = args.nodesByHour.length;
  if (hourCount === 0) return {};
  const columnsPerHour = 8;
  const rowHeightPx = 3;

  const valueAt = (hourIndex: number, distancePx: number): number | null => {
    const nodes = args.nodesByHour[hourIndex];
    if (!nodes.length) return null;
    return sampleField(nodes, Math.min(distancePx, nodes[nodes.length - 1].distanceFromBottomPx), 'distanceFromBottomPx');
  };

  const columns = hourCount * columnsPerHour;
  const times = Array.from({ length: columns + 1 }, (_, column) => {
    const time = Math.min(hourCount - 1, Math.max(0, column / columnsPerHour - 0.5));
    const lower = Math.floor(time);
    return { lower, upper: Math.ceil(time), fraction: time - lower };
  });
  const plotHeight = args.plotBottom - args.plotTop;
  const rows = Math.max(1, Math.ceil(plotHeight / rowHeightPx));
  const values: (number | null)[][] = [];
  for (let row = 0; row <= rows; row += 1) {
    const distancePx = plotHeight - (row / rows) * plotHeight;
    const atHour = args.nodesByHour.map((_, hourIndex) => valueAt(hourIndex, distancePx));
    values.push(times.map(({ lower, upper, fraction }) => {
      const a = atHour[lower], b = atHour[upper];
      if (lower === upper) return a;
      if (a === null) return fraction >= 0.5 ? b : null;
      if (b === null) return fraction <= 0.5 ? a : null;
      return a + (b - a) * fraction;
    }));
  }

  const xOf = (column: number) => hourX(args.hours, column / columns * hourCount - 0.5, args.columnWidth);
  const left = xOf(0), right = xOf(columns);
  const yOf = (row: number) => args.plotTop + (row / rows) * plotHeight;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  const shortNum = (v: number) => Number(v.toFixed(1));

  let centrePredicate: (mean: number, allValid: boolean) => boolean = () => false;
  const rings = (inside: (r: number, c: number) => boolean, fraction: (a: number | null, b: number | null) => number) => {
    type Seg = { from: [number, number]; to: [number, number]; used: boolean };
    const allSegments: Seg[] = [];
    const byStart = new Map<string, Seg[]>();
    const key = (point: [number, number]) => `${point[0].toFixed(3)},${point[1].toFixed(3)}`;
    const addSegment = (from: [number, number], to: [number, number]) => {
      const fromKey = key(from);
      if (fromKey === key(to)) return;
      const segment: Seg = { from, to, used: false };
      allSegments.push(segment);
      const queue = byStart.get(fromKey);
      if (queue) queue.push(segment);
      else byStart.set(fromKey, [segment]);
    };
    const insideAt = (r: number, c: number) => r >= 0 && r <= rows && c >= 0 && c <= columns && inside(r, c);
    const valAt = (r: number, c: number) => (r >= 0 && r <= rows && c >= 0 && c <= columns ? values[r][c] : null);
    const clampX = (x: number) => Math.min(right, Math.max(left, x));
    const clampY = (y: number) => Math.min(args.plotBottom, Math.max(args.plotTop, y));

    const saddleCentreInside = (r: number, c: number) => {
      const corners = [valAt(r, c), valAt(r, c + 1), valAt(r + 1, c + 1), valAt(r + 1, c)].filter((v): v is number => v !== null);
      if (corners.length === 0) return false;
      const mean = corners.reduce((sum, v) => sum + v, 0) / corners.length;
      return centrePredicate(mean, corners.length === 4);
    };

    for (let r = -1; r <= rows; r += 1) {
      for (let c = -1; c <= columns; c += 1) {
        const tl = insideAt(r, c);
        const tr = insideAt(r, c + 1);
        const br = insideAt(r + 1, c + 1);
        const bl = insideAt(r + 1, c);
        const caseIndex = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
        if (caseIndex === 0 || caseIndex === 15) continue;
        const vTL = valAt(r, c);
        const vTR = valAt(r, c + 1);
        const vBR = valAt(r + 1, c + 1);
        const vBL = valAt(r + 1, c);
        const topPt: [number, number] = [clampX(xOf(c + fraction(vTL, vTR))), clampY(yOf(r))];
        const bottomPt: [number, number] = [clampX(xOf(c + fraction(vBL, vBR))), clampY(yOf(r + 1))];
        const leftPt: [number, number] = [clampX(xOf(c)), clampY(yOf(r + fraction(vTL, vBL)))];
        const rightPt: [number, number] = [clampX(xOf(c + 1)), clampY(yOf(r + fraction(vTR, vBR)))];
        switch (caseIndex) {
          case 1: addSegment(leftPt, bottomPt); break;
          case 2: addSegment(bottomPt, rightPt); break;
          case 3: addSegment(leftPt, rightPt); break;
          case 4: addSegment(rightPt, topPt); break;
          case 6: addSegment(bottomPt, topPt); break;
          case 7: addSegment(leftPt, topPt); break;
          case 8: addSegment(topPt, leftPt); break;
          case 9: addSegment(topPt, bottomPt); break;
          case 11: addSegment(topPt, rightPt); break;
          case 12: addSegment(rightPt, leftPt); break;
          case 13: addSegment(rightPt, bottomPt); break;
          case 14: addSegment(bottomPt, leftPt); break;
          case 5:
            if (saddleCentreInside(r, c)) { addSegment(leftPt, topPt); addSegment(rightPt, bottomPt); }
            else { addSegment(leftPt, bottomPt); addSegment(rightPt, topPt); }
            break;
          case 10:
            if (saddleCentreInside(r, c)) { addSegment(topPt, rightPt); addSegment(bottomPt, leftPt); }
            else { addSegment(topPt, leftPt); addSegment(bottomPt, rightPt); }
            break;
        }
      }
    }
    const takeFrom = (pointKey: string) => {
      const queue = byStart.get(pointKey);
      if (!queue) return null;
      while (queue.length > 0) {
        const candidate = queue[queue.length - 1];
        if (!candidate.used) return candidate;
        queue.pop();
      }
      return null;
    };
    const out: [number, number][][] = [];
    for (const first of allSegments) {
      if (first.used) continue;
      const ring: [number, number][] = [first.from];
      let current: Seg | null = first;
      while (current) {
        current.used = true;
        ring.push(current.to);
        current = takeFrom(key(current.to));
      }
      if (ring.length >= 4) out.push(ring);
    }
    return out;
  };

  const thresholdRings = (t: number) => {
    centrePredicate = (mean, allValid) => allValid && mean >= t;
    return rings(
      (r, c) => {
        const v = values[r][c];
        return v !== null && v >= t;
      },
      (a, b) => {
        if (a === null || b === null || a === b) return 0.5;
        return clamp01((t - a) / (b - a));
      },
    );
  };
  const domainRings = () => {
    centrePredicate = (_mean, allValid) => allValid;
    return rings((r, c) => values[r][c] !== null, () => 0.5);
  };

  const ringCache = new Map<number, [number, number][][]>();
  const ringsAt = (t: number) => {
    let cached = ringCache.get(t);
    if (!cached) {
      cached = thresholdRings(t);
      ringCache.set(t, cached);
    }
    return cached;
  };

  const toPath = (ringSets: [number, number][][][]) => {
    const parts: string[] = [];
    for (const set of ringSets) {
      for (const ring of set) {
        const rounded: [number, number][] = [];
        for (const point of ring) {
          const x = shortNum(point[0]);
          const y = shortNum(point[1]);
          const last = rounded[rounded.length - 1];
          if (last && last[0] === x && last[1] === y) continue;
          const beforeLast = rounded[rounded.length - 2];
          if (last && beforeLast) {
            const cross = (last[0] - beforeLast[0]) * (y - beforeLast[1]) - (last[1] - beforeLast[1]) * (x - beforeLast[0]);
            if (Math.abs(cross) < 0.35) {
              last[0] = x;
              last[1] = y;
              continue;
            }
          }
          rounded.push([x, y]);
        }
        if (rounded.length >= 3) {
          parts.push(rounded.map(([x, y], idx) => `${idx === 0 ? 'M' : 'L'}${x} ${y}`).join('') + 'Z');
        }
      }
    }
    return parts.join('');
  };

  const result: Record<string, string> = {};
  const { breakpoints, classNames } = args.banding;
  for (let interval = 0; interval < classNames.length; interval += 1) {
    const className = classNames[interval];
    if (!className) continue;
    const lower = interval === 0 ? null : breakpoints[interval - 1];
    const upper = interval === classNames.length - 1 ? null : breakpoints[interval];
    const sets: [number, number][][][] = [];
    if (lower === null) {
      sets.push(domainRings());
      if (upper !== null) sets.push(ringsAt(upper));
    } else {
      sets.push(ringsAt(lower));
      if (upper !== null) sets.push(ringsAt(upper));
    }
    const path = toPath(sets);
    if (path !== '') result[className] = result[className] ? result[className] + path : path;
  }
  return result;
}

/**
 * Marching squares over the actual temperature field, with null cells left open.
 * Returns structured segments and connected components alongside the SVG path string.
 */
export function temperatureContours(
  view: WindgramScale & {
    plotHeight: number;
    columnWidth: number;
    hours: readonly { validAt: string; x: number }[];
    sampling: readonly HourSampling[];
  },
  system: UnitSystem,
): TemperatureContour[] {
  const temperatures = view.sampling.flatMap((s) => s.temperatureC.map((n) => n.value)).filter(Number.isFinite);
  if (!temperatures.length || view.hours.length < 2) return [];
  const metric = system === 'metric';
  const step = metric ? 5 : 8;
  const low = Math.floor(convertQuantity(Math.min(...temperatures), 'temperature', system)! / step) * step;
  const high = Math.ceil(convertQuantity(Math.max(...temperatures), 'temperature', system)! / step) * step;
  const cols = Math.max(2, (view.hours.length - 1) * 8);
  const rows = Math.ceil(view.plotHeight / 4);
  const times = Array.from({ length: cols + 1 }, (_, c) => (view.hours.length - 1) * c / cols);
  const ys = Array.from({ length: rows + 1 }, (_, r) => view.top + (view.plotHeight * r) / rows);
  const xs = times.map(time => hourX(view.hours, time, view.columnWidth));
  const grid = ys.map(y => {
    const z = yToHeight(view, y);
    const atHour = view.sampling.map(hour => sampleHeight(hour.temperatureC, z));
    return times.map(time => {
      const lower = Math.floor(time), upper = Math.ceil(time);
      const a = atHour[lower], b = atHour[upper];
      return a === null || b === null ? null : a + (b - a) * (time - lower);
    });
  });
  const labelHours = new Set<number>();
  let lastLabelTime = -Infinity;
  view.hours.forEach((h, i) => {
    if (i === 0 && view.hours.length >= 3) return;
    const time = Date.parse(h.validAt);
    if (time - lastLabelTime >= 3 * 3_600_000) {
      labelHours.add(i);
      lastLabelTime = time;
    }
  });
  const contours: TemperatureContour[] = [];
  for (let value = low; value <= high; value += step) {
    // Preserve operation order at exact-threshold corners: /1.8 can round to
    // the other side of a sample and change marching-square connectivity.
    const target = metric ? value : (value - 32) * 5 / 9;
    const f = metric ? celsiusToFahrenheit(target) : value;
    const segments: ContourSegment[] = [];
    const pathParts: string[] = [];
    const addLine = (a: Point, b: Point) => {
      const x1 = round(a.x), y1 = round(a.y), x2 = round(b.x), y2 = round(b.y);
      segments.push({ x1, y1, x2, y2 });
      pathParts.push(`M${x1},${y1}L${x2},${y2}`);
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = [grid[r][c], grid[r][c + 1], grid[r + 1][c + 1], grid[r + 1][c]];
        if (v.some((n) => n === null)) continue;
        const values = v as number[];
        const p = [
          { x: xs[c], y: ys[r] },
          { x: xs[c + 1], y: ys[r] },
          { x: xs[c + 1], y: ys[r + 1] },
          { x: xs[c], y: ys[r + 1] },
        ];
        const edges: { edge: number; p: Point }[] = [];
        for (let e = 0; e < 4; e++) {
          const n = (e + 1) % 4;
          if ((values[e] >= target) === (values[n] >= target)) continue;
          const fraction = (target - values[e]) / (values[n] - values[e]);
          edges.push({
            edge: e,
            p: { x: p[e].x + (p[n].x - p[e].x) * fraction, y: p[e].y + (p[n].y - p[e].y) * fraction },
          });
        }
        if (edges.length === 2) addLine(edges[0].p, edges[1].p);
        if (edges.length === 4) {
          // Resolve saddles by their centre; preserve both independent branches.
          const sameAsTopLeft = (values.reduce((sum, n) => sum + n, 0) / 4 >= target) === (values[0] >= target);
          if (sameAsTopLeft) {
            addLine(edges[0].p, edges[1].p);
            addLine(edges[2].p, edges[3].p);
          } else {
            addLine(edges[0].p, edges[3].p);
            addLine(edges[1].p, edges[2].p);
          }
        }
      }
    }
    const labels = view.hours.flatMap((h, i) =>
      labelHours.has(i)
        ? crossings(view.sampling[i].temperatureC, target)
            .filter(z => z >= view.floorM && z <= view.topM)
            .map((z) => ({ x: h.x, y: heightToY(view, z) }))
        : [],
    );
    if (segments.length || labels.length) {
      const components = buildContourComponentsFromSegments(segments, labels);
      contours.push({
        temperatureF: f,
        path: pathParts.join(''),
        labels,
        segments,
        components,
      });
    }
  }
  return contours;
}
