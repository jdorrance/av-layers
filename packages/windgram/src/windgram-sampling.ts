// Physical column sampling, interval lapse-rate reconstruction, and moist-layer
// detection for Windgram charts.

import {
  lapseRateCPer1000Ft,
  type FieldNode,
  type HourSampling,
  type PublishedForecastHour as ProfileHour,
} from './internal-meteo.ts';
import { relativeHumidityFromTempAndDewpointPercent } from '@av/thermodynamics';
import { finiteScalar } from './windgram-format.ts';

export type Point = { x: number; y: number };
export const CLOUD_RH_THRESHOLD_PERCENT = 94;

const round = (n: number) => Math.round(n * 100) / 100;

/** Linear interpolation in physical height. Never bridge an explicitly missing level. */
export function sampleHeight(nodes: readonly FieldNode[], heightM: number): number | null {
  return sampleField(nodes, heightM, 'altitudeM');
}

/** Interpolate an ordered field along its declared axis, preserving gaps. */
export function sampleField<Axis extends string>(nodes: readonly (Record<Axis, number> & { value: number })[], position: number, axis: Axis): number | null {
  if (!nodes.length || position < nodes[0][axis] || position > nodes[nodes.length - 1][axis]) return null;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    if (Math.abs(a[axis] - position) < 0.00001) {
      if (Number.isFinite(a.value)) return a.value;
      const next = nodes[i + 1];
      if (next && Math.abs(next[axis] - position) < 0.00001 && Number.isFinite(next.value)) return next.value;
      return null;
    }
    const b = nodes[i + 1];
    if (b && position > a[axis] && position < b[axis]) {
      if (!Number.isFinite(a.value) || !Number.isFinite(b.value)) return null;
      return a.value + (b.value - a.value) * (position - a[axis]) / (b[axis] - a[axis]);
    }
  }
  return null;
}

type HeightGap = readonly [lower: number, upper: number];

/** Published levels retain their order when a height is missing. */
function profileHeightGaps(levels: ProfileHour['levels']): HeightGap[] {
  const gaps: HeightGap[] = [];
  let lower = -Infinity, pending = false;
  for (const { heightM } of levels) {
    if (heightM === null) { pending = true; continue; }
    if (pending) gaps.push([lower, heightM]);
    lower = heightM;
    pending = false;
  }
  if (pending) gaps.push([lower, Infinity]);
  return gaps;
}

/** Keep known endpoints readable and block interpolation across a missing level. */
function withHeightGaps<T extends { altitudeM: number }>(nodes: T[], gaps: readonly HeightGap[], missing: (heightM: number) => T): T[] {
  if (!gaps.length) return nodes;
  const result: T[] = [];
  let gapIndex = 0;
  for (const [i, node] of nodes.entries()) {
    result.push(node);
    const next = nodes[i + 1];
    if (!next || next.altitudeM <= node.altitudeM) continue;
    while (gapIndex < gaps.length && gaps[gapIndex][1] <= node.altitudeM) gapIndex++;
    if (gapIndex < gaps.length && gaps[gapIndex][0] < next.altitudeM) {
      result.push(missing((node.altitudeM + next.altitudeM) / 2));
    }
  }
  return result;
}

export function hourSampling(hour: ProfileHour): HourSampling {
  const floorM = hour.modelTerrainM;
  const levels = hour.levels.filter(l => l.heightM !== null && (floorM === null || l.heightM > floorM));
  const gaps = profileHeightGaps(hour.levels);
  const missingValue = (altitudeM: number) => ({ altitudeM, value: NaN });
  const nodes = (key: 'temperatureC' | 'dewPointC') => withHeightGaps([
    ...(floorM === null ? [] : [{ altitudeM: floorM + 2, value: finiteScalar(hour.surface[key]) ?? NaN }]),
    ...levels.map((l) => ({ altitudeM: finiteScalar(l.heightM)!, value: finiteScalar(l[key]) ?? NaN })),
  ].sort((a, b) => a.altitudeM - b.altitudeM), gaps, missingValue);
  const temperatureC = nodes('temperatureC'), dewPointC = nodes('dewPointC');
  const wind = (u: number | null, v: number | null) => {
    return u === null || v === null ? { uMps: NaN, vMps: NaN } : { uMps: u, vMps: v };
  };
  const surface = hour.surface;
  const winds = withHeightGaps([
    ...(floorM === null ? [] : [{ altitudeM: floorM + 10, ...wind(surface.windU, surface.windV) }]),
    ...levels.map((l) => ({ altitudeM: finiteScalar(l.heightM)!, ...wind(l.uWindMps, l.vWindMps) })),
  ].sort((a, b) => a.altitudeM - b.altitudeM), gaps, altitudeM => ({ altitudeM, uMps: NaN, vMps: NaN }));
  // Duplicate source heights leave the surrounding interpolation unavailable.
  for (let i = 0; i < winds.length; i++) {
    if ((i > 0 && winds[i - 1].altitudeM === winds[i].altitudeM) || winds[i + 1]?.altitudeM === winds[i].altitudeM) {
      winds[i].uMps = NaN;
      winds[i].vMps = NaN;
    }
  }
  // Represent temperature gradients as interval quantities, constant within each source interval.
  // Use a tiny step epsilon before interior upper endpoints so interval transitions stay sharp.
  const lastIdx = temperatureC.length - 2;
  const lapseCPer1000Ft = temperatureC.slice(0, -1).flatMap((a, i) => {
    const b = temperatureC[i + 1];
    if (!b) return [];
    const value =
      Number.isFinite(a.value) && Number.isFinite(b.value)
        ? lapseRateCPer1000Ft({ heightM: a.altitudeM, temperatureC: a.value }, { heightM: b.altitudeM, temperatureC: b.value }) ?? NaN
        : NaN;
    const upperAlt = i < lastIdx && b.altitudeM - a.altitudeM > 0.02 ? b.altitudeM - 0.01 : b.altitudeM;
    return [{ altitudeM: a.altitudeM, value }, { altitudeM: upperAlt, value }];
  });
  return {
    validAt: hour.validAt,
    temperatureC,
    dewPointC,
    lapseCPer1000Ft,
    relativeHumidityPercent: temperatureC.map((p, i) => ({
      altitudeM: p.altitudeM,
      value: relativeHumidityFromTempAndDewpointPercent(p.value, dewPointC[i].value),
    })),
    windU: winds.map(p => ({ altitudeM: p.altitudeM, value: p.uMps })),
    windV: winds.map(p => ({ altitudeM: p.altitudeM, value: p.vMps })),
    verticalVelocityPaS: withHeightGaps(levels.map((l) => ({
      altitudeM: finiteScalar(l.heightM)!,
      value: l.omegaPaS ?? NaN,
    })), gaps, missingValue),
  };
}

/** Reconstruct the colour field from interval centres. Source lapse rates stay
 * layer averages; this interpolation is only for drawing. Keep the edge of
 * each valid run, and pin zero crossings to the source inversion boundaries.
 */
export function stabilityDisplayNodes(intervals: readonly FieldNode[]): FieldNode[] {
  const nodes: FieldNode[] = [];
  for (let i = 0; i + 1 < intervals.length; i += 2) {
    const { altitudeM: base, value } = intervals[i];
    const upper = intervals[i + 2]?.altitudeM ?? intervals[i + 1].altitudeM;
    if (!Number.isFinite(value)) {
      nodes.push({ altitudeM: base, value: NaN }, { altitudeM: upper, value: NaN });
      continue;
    }
    const previous = intervals[i - 2]?.value, next = intervals[i + 2]?.value;
    if (!Number.isFinite(previous)) nodes.push({ altitudeM: base, value });
    else if (previous * value <= 0 && previous !== value) nodes.push({ altitudeM: base, value: 0 });
    nodes.push({ altitudeM: (base + upper) / 2, value });
    if (!Number.isFinite(next)) nodes.push({ altitudeM: upper, value });
  }
  return nodes;
}

/** All crossing branches, including an inversion's second crossing. */
export function crossings(nodes: readonly FieldNode[], target: number): number[] {
  const heights: number[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || a.value === b.value) continue;
    if (target < Math.min(a.value, b.value) || target > Math.max(a.value, b.value)) continue;
    const z = a.altitudeM + (b.altitudeM - a.altitudeM) * (target - a.value) / (b.value - a.value);
    if (!heights.some((h) => Math.abs(h - z) < 0.01)) heights.push(z);
  }
  return heights;
}

/** Contiguous portions of a profile at or above the cloud-evidence threshold. */
export function moistLayers(nodes: readonly FieldNode[]) {
  const threshold = CLOUD_RH_THRESHOLD_PERCENT;
  const layers: { baseM: number; topM: number }[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1], b = nodes[i];
    if (!Number.isFinite(a.value) || !Number.isFinite(b.value) || Math.max(a.value, b.value) < threshold) continue;
    let baseM = a.altitudeM, topM = b.altitudeM;
    if (a.value < threshold) baseM += (topM - baseM) * (threshold - a.value) / (b.value - a.value);
    if (b.value < threshold) topM = a.altitudeM + (b.altitudeM - a.altitudeM) * (threshold - a.value) / (b.value - a.value);
    if (topM - baseM < 1) continue;
    const last = layers[layers.length - 1];
    if (last && Math.abs(last.topM - baseM) < 1) last.topM = topM;
    else layers.push({ baseM, topM });
  }
  return layers;
}

export function linearPath(points: readonly (Point | null)[]): string {
  let open = false;
  return points
    .map((p) => {
      if (!p) {
        open = false;
        return '';
      }
      const cmd = open ? 'L' : 'M';
      open = true;
      return `${cmd}${round(p.x)},${round(p.y)}`;
    })
    .join('');
}
