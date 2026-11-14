import { displayedWindSpeed, quantizedBarbSpeed } from '@av/contracts/units';

export { displayedWindSpeed as displayedBarbSpeed, quantizedBarbSpeed };

export interface WindBarbGeometry {
  staff: string;
  flags: string[];
  calm: boolean;
  /** Rounded vertices used by the rendered paths, relative to the staff origin. */
  points: readonly (readonly [number, number])[];
}

/** Wind-barb paths and vertices share WMO/ICAO knot quantization, <2.5 kt calm threshold, and hemisphere flip. */
export function barbGeometry(speedKt: number, directionDeg: number, staffLength: number, southernHemisphere: boolean): WindBarbGeometry {
  if (!Number.isFinite(speedKt) || speedKt < 0 || !Number.isFinite(directionDeg)) return { staff: '', flags: [], calm: false, points: [] };
  const rounded = quantizedBarbSpeed(speedKt);
  if (rounded === 0) return { staff: '', flags: [], calm: true, points: [] };
  const rad = (directionDeg * Math.PI) / 180, ux = Math.sin(rad), uy = -Math.cos(rad);
  const side = southernHemisphere ? -1 : 1, px = -uy * side, py = ux * side;
  const points: (readonly [number, number])[] = [[0, 0]];
  const vertex = (x: number, y: number) => {
    points.push([+x.toFixed(1), +y.toFixed(1)]);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const staff = `M0,0L${vertex(ux * staffLength, uy * staffLength)}`, flags: string[] = [];
  const pennants = Math.min(16, Math.floor(rounded / 50)), feathers = Math.floor((rounded % 50) / 10), half = rounded % 10 >= 5;
  const compression = Math.min(1, staffLength / Math.max(1, pennants * 8 + feathers * 4 + (half ? 4 : 0)));
  let d = staffLength;
  for (let i = 0; i < pennants; i++) {
    const ax = ux * d, ay = uy * d;
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9, ay + py * 9)}L${vertex(ux * (d - 6 * compression), uy * (d - 6 * compression))}Z`);
    d -= 8 * compression;
  }
  for (let i = 0; i < feathers; i++) {
    const ax = ux * d, ay = uy * d, lean = Math.min(3 * compression, staffLength - d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9 + ux * lean, ay + py * 9 + uy * lean)}`);
    d -= 4 * compression;
  }
  if (half) {
    if (d === staffLength) d -= 4 * compression;
    const ax = ux * d, ay = uy * d, lean = Math.min(1.5 * compression, staffLength - d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 5 + ux * lean, ay + py * 5 + uy * lean)}`);
  }
  return { staff, flags, calm: false, points };
}
