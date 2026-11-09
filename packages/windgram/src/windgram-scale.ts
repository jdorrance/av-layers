// Vertical altitude/pressure scale construction and screen-coordinate transforms
// for Windgram charts.

import type { SiteForecast } from './internal-meteo.ts';
import { finiteScalar } from './windgram-format.ts';
import { median } from './windgram-time-axis.ts';

export interface HeightAnchor {
  heightM: number;
  y: number;
  pressureHpa: number | null;
}

export interface WindgramScale {
  anchors: readonly HeightAnchor[];
  top: number;
  bottom: number;
  floorM: number;
  topM: number;
}

const ICON_ISOBAR_TICKS_HPA = [
  1000, 975, 950, 925, 900, 875, 850, 800, 750, 700, 650,
  600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100,
] as const;

export function heightToY(view: WindgramScale, heightM: number): number {
  const anchors = view.anchors;
  if (heightM <= view.floorM) return view.bottom;
  if (heightM >= view.topM) return view.top;
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1], b = anchors[i];
    if (heightM <= b.heightM) return a.y + (b.y - a.y) * (heightM - a.heightM) / (b.heightM - a.heightM);
  }
  return view.top;
}

export function yToHeight(view: WindgramScale, y: number): number {
  if (y >= view.bottom) return view.floorM;
  if (y <= view.top) return view.topM;
  for (let i = 1; i < view.anchors.length; i++) {
    const a = view.anchors[i - 1], b = view.anchors[i];
    if (y >= b.y) return a.heightM + (b.heightM - a.heightM) * (a.y - y) / (a.y - b.y);
  }
  return view.topM;
}

/** Compare with the last retained label so dense profiles still have an axis. */
export function visibleHeightAnchors(
  view: { anchors: readonly HeightAnchor[]; top: number; compact: boolean },
): HeightAnchor[] {
  const minimumGap = view.compact ? 23 : 29;
  const selected: HeightAnchor[] = [];
  for (const anchor of view.anchors) {
    const previous = selected.at(-1);
    if (!previous || (anchor.y - view.top > 20 && previous.y - anchor.y >= minimumGap)) selected.push(anchor);
  }
  return selected;
}

/**
 * Builds the piecewise-linear vertical height/pressure scale and cropped anchors
 * for either full-profile or focused soaring-band views.
 */
export function buildWindgramVerticalScale(
  profile: SiteForecast,
  hours: readonly SiteForecast['hours'][number][],
  options: {
    compact: boolean;
    heightRange?: 'soaring' | 'full';
    top: number;
    bottom: number;
    plotHeight: number;
  },
): {
  floorM: number;
  topM: number;
  anchors: HeightAnchor[];
} {
  const { compact, top, bottom, plotHeight } = options;
  const known = (values: (number | null)[]) => values.filter((value): value is number => value !== null);
  const grounds = known(hours.map(hour => hour.modelTerrainM));
  const fineTerrain = known(hours.map(hour => hour.mapLift.terrainM));
  const liftTops = known(hours.map(hour => hour.mapLift.mslM));
  const heights = known(hours.flatMap(hour => hour.levels.map(level => level.heightM)));
  const referenceHeights = [...grounds, ...fineTerrain, ...heights, ...liftTops];
  // Add room around an isolated ceiling so its marker fits inside the plot.
  const floorM = referenceHeights.length ? Math.min(...referenceHeights, ...liftTops.map(height => height - 50)) : 0;
  const focused = compact && options.heightRange !== 'full';
  const grouped = new Map<number, number[]>();

  if (profile.model === 'icon-eu') {
    // Native hybrid pressures change with each forecast hour. Fixed isobar ticks
    // keep the display scale independent of that changing pressure inventory.
    for (const hour of hours) {
      const levels = hour.levels
        .map(level => ({ p: finiteScalar(level.pressureHpa), z: finiteScalar(level.heightM) }))
        .filter((level): level is { p: number; z: number } => level.p !== null && level.p > 0 && level.z !== null)
        .sort((a, b) => a.z - b.z);
      for (const p of ICON_ISOBAR_TICKS_HPA) {
        for (let i = 1; i < levels.length; i++) {
          const a = levels[i - 1], b = levels[i];
          if (a.p <= b.p || p > a.p || p < b.p) continue;
          const fraction = (Math.log(p) - Math.log(a.p)) / (Math.log(b.p) - Math.log(a.p));
          const z = a.z + fraction * (b.z - a.z);
          if (z > (hour.modelTerrainM ?? floorM) + 5) grouped.set(p, [...(grouped.get(p) ?? []), z]);
          break;
        }
      }
    }
  } else {
    for (const h of hours) {
      for (const l of h.levels) {
        const p = finiteScalar(l.pressureHpa), z = finiteScalar(l.heightM);
        if (p !== null && z !== null && z > (h.modelTerrainM ?? floorM) + 5) grouped.set(p, [...(grouped.get(p) ?? []), z]);
      }
    }
  }

  const levelAnchors = [...grouped]
    .map(([pressureHpa, zs]) => ({ pressureHpa, heightM: median(zs) }))
    .sort((a, b) => a.heightM - b.heightM)
    .filter((a, i, all) => i === 0 || a.heightM > all[i - 1].heightM + 5);

  const highest = Math.max(floorM + 800, ...referenceHeights);
  const fullTopM = highest + (highest - floorM) * 0.04;

  const peakM = Math.max(floorM, ...grounds, ...fineTerrain, ...liftTops);
  const focusedTopM = Math.ceil(Math.max(floorM + 1000, peakM + Math.max(500, (peakM - floorM) * 0.25)) / 250) * 250;
  const calmDay = hours.length > 0 && hours.every(hour => hour.thermalVelocityMps === 0);
  const topM = focused && (liftTops.length || calmDay) ? Math.min(fullTopM, focusedTopM) : fullTopM;

  const modelGround = grounds.length ? Math.min(...grounds) : null;
  const baseAnchors = [
    { pressureHpa: null, heightM: floorM },
    ...(modelGround !== null && modelGround > floorM ? [{ pressureHpa: null, heightM: modelGround }] : []),
    ...levelAnchors.filter(anchor => anchor.heightM > (modelGround ?? floorM) + 5)
  ];
  // A short headroom segment leaves the top native wind barb inside the frame.
  const span = Math.max(1, baseAnchors.length - 1) + 0.35;
  const fullAnchors: HeightAnchor[] = baseAnchors.map((a, i) => ({ ...a, y: bottom - (plotHeight * i) / span }));
  fullAnchors.push({ pressureHpa: null, heightM: fullTopM, y: top });

  const fullScale: WindgramScale = { anchors: fullAnchors, floorM, topM: fullTopM, top, bottom };
  const croppedTopY = heightToY(fullScale, topM);
  const croppedBottomY = heightToY(fullScale, floorM);
  const anchors: HeightAnchor[] = [
    { pressureHpa: null, heightM: floorM, y: bottom },
    ...fullAnchors
      .filter(a => a.heightM > floorM && a.heightM < topM)
      .map(a => ({ ...a, y: bottom - ((croppedBottomY - a.y) * plotHeight) / (croppedBottomY - croppedTopY) })),
  ];
  anchors.push({ pressureHpa: null, heightM: topM, y: top });

  return { floorM, topM, anchors };
}
