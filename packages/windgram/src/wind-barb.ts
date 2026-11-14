export { displayedWindSpeed as displayedBarbSpeed } from '@av/contracts/units';

export function quantizedBarbSpeed(speed: number): number {
  return speed > 0 ? Math.max(5, Math.round(speed / 5) * 5) : 0;
}

interface WindBarbGeometry {
  staff: string;
  flags: string[];
  calm: boolean;
  /** Rounded vertices used by the rendered paths, relative to the staff origin. */
  points: readonly (readonly [number, number])[];
}

/** Wind-barb paths and vertices share the same geometry and speed quantization. */
export function barbGeometry(speed: number, directionDeg: number, staffLength: number, southernHemisphere: boolean): WindBarbGeometry {
  if (!Number.isFinite(speed) || speed < 0 || !Number.isFinite(directionDeg)) return { staff: '', flags: [], calm: false, points: [] };
  if (speed === 0) return { staff: '', flags: [], calm: true, points: [] };
  const len = staffLength;
  const rad = (directionDeg * Math.PI) / 180;
  const ux = Math.sin(rad);
  const uy = -Math.cos(rad);
  const side = southernHemisphere ? -1 : 1;
  const px = -uy * side;
  const py = ux * side;
  const at = (d: number) => [ux * d, uy * d] as const;
  const points: (readonly [number, number])[] = [[0, 0]];
  const vertex = (x: number, y: number) => {
    points.push([Number(x.toFixed(1)), Number(y.toFixed(1))]);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  };
  const [ex, ey] = at(len);
  const staff = `M0,0L${vertex(ex, ey)}`;
  const flags: string[] = [];
  const rounded = quantizedBarbSpeed(speed);
  const pennants = Math.min(16, Math.floor(rounded / 50));
  const feathers = Math.floor((rounded % 50) / 10);
  const half = rounded % 10 >= 5;
  const compression = Math.min(1, len / Math.max(1, pennants * 8 + feathers * 4 + (half ? 4 : 0)));
  let d = len;
  for (let i = 0; i < pennants; i += 1) {
    const [ax, ay] = at(d);
    const [bx, by] = at(d - 6 * compression);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9, ay + py * 9)}L${vertex(bx, by)}Z`);
    d -= 8 * compression;
  }
  for (let i = 0; i < feathers; i += 1) {
    const [ax, ay] = at(d);
    const lean = Math.min(3 * compression, len - d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9 + ux * lean, ay + py * 9 + uy * lean)}`);
    d -= 4 * compression;
  }
  if (half) {
    if (d === len) d -= 4 * compression;
    const [ax, ay] = at(d);
    const lean = Math.min(1.5 * compression, len - d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 5 + ux * lean, ay + py * 5 + uy * lean)}`);
  }
  return { staff, flags, calm: false, points };
}
