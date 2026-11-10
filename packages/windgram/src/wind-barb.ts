interface WindBarbGeometry {
  staff: string;
  flags: string[];
  calm: boolean;
  /** Rounded vertices used by the rendered paths, relative to the staff origin. */
  points: readonly (readonly [number, number])[];
}

/** Wind-barb paths and vertices share the same geometry and speed quantization. */
export function barbGeometry(speedKt: number, directionDeg: number, staffLength: number, southernHemisphere: boolean): WindBarbGeometry {
  if (!Number.isFinite(speedKt) || speedKt < 0 || !Number.isFinite(directionDeg)) return { staff: '', flags: [], calm: false, points: [] };
  if (speedKt < 2.5) return { staff: '', flags: [], calm: true, points: [] };
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
  let remaining = Math.round(speedKt / 5) * 5;
  let d = len;
  while (remaining >= 50) {
    const [ax, ay] = at(d);
    const [bx, by] = at(d - 6);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9, ay + py * 9)}L${vertex(bx, by)}Z`);
    remaining -= 50;
    d -= 8;
  }
  while (remaining >= 10) {
    const [ax, ay] = at(d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 9 + ux * 3, ay + py * 9 + uy * 3)}`);
    remaining -= 10;
    d -= 4;
  }
  if (remaining >= 5) {
    if (d === len) d -= 4;
    const [ax, ay] = at(d);
    flags.push(`M${vertex(ax, ay)}L${vertex(ax + px * 5 + ux * 1.5, ay + py * 5 + uy * 1.5)}`);
  }
  return { staff, flags, calm: false, points };
}
