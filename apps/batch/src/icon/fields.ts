import type { IconPrecipitationWindow, IconRecord } from './types.ts';

export class IconAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'IconAdapterError';
    this.code = code;
  }
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function requireConsecutiveInitMeans(current: IconRecord, previous: IconRecord | undefined, startHour: number, endHour: number): void {
  const c = current.metadata;
  if (c.stepType !== 'avg' || c.units !== 'W m**-2') throw new IconAdapterError('flux-units', 'ICON heat flux requires run-mean W m**-2 records');
  if (!finite(c.startHour) || !finite(c.endHour) || c.startHour !== 0 || c.endHour !== endHour || endHour <= startHour) {
    throw new IconAdapterError('flux-window', 'ICON heat flux current record is not the initialization mean ending at the requested hour');
  }
  if (startHour === 0) return;
  if (!previous) throw new IconAdapterError('flux-predecessor', 'ICON heat flux window requires its predecessor initialization mean');
  const p = previous.metadata;
  if (p.stepType !== 'avg' || p.units !== c.units || !finite(p.startHour) || !finite(p.endHour) || p.startHour !== 0 || p.endHour !== startHour) {
    throw new IconAdapterError('flux-window', 'ICON heat flux predecessor is not the initialization mean ending at the window start');
  }
}

export function iconWindowMeanUpwardFlux(
  current: IconRecord | undefined,
  previous: IconRecord | undefined,
  startHour: number,
  endHour: number,
  index: number,
): number | null {
  if (!current) throw new IconAdapterError('flux-missing', 'ICON heat flux current record is unavailable');
  requireConsecutiveInitMeans(current, previous, startHour, endHour);
  const value = current.values[index];
  if (!finite(value)) return null;
  if (startHour === 0) {
    const upward = -value;
    return upward === 0 ? 0 : upward;
  }
  if (!previous) throw new IconAdapterError('flux-predecessor', 'ICON heat flux window requires its predecessor initialization mean');
  const prior = previous.values[index];
  if (!finite(prior)) return null;
  const downward = (value * endHour - prior * startHour) / (endHour - startHour);
  const upward = -downward;
  return upward === 0 ? 0 : upward;
}

function requireConsecutiveInitAccumulations(current: IconRecord, previous: IconRecord | undefined, startHour: number, endHour: number): void {
  const c = current.metadata;
  if (c.stepType !== 'accum' || c.units !== 'kg m**-2') throw new IconAdapterError('precip-units', 'ICON precipitation requires run accumulation kg m**-2 records');
  if (!finite(c.startHour) || !finite(c.endHour) || c.startHour !== 0 || c.endHour !== endHour || endHour <= startHour) {
    throw new IconAdapterError('precip-window', 'ICON precipitation current record is not the initialization accumulation ending at the requested hour');
  }
  if (startHour === 0) return;
  if (!previous) throw new IconAdapterError('precip-predecessor', 'ICON precipitation window requires its predecessor accumulation');
  const p = previous.metadata;
  if (p.stepType !== 'accum' || p.units !== c.units || !finite(p.startHour) || !finite(p.endHour) || p.startHour !== 0 || p.endHour !== startHour) {
    throw new IconAdapterError('precip-window', 'ICON precipitation predecessor is not the initialization accumulation ending at the window start');
  }
}

export function iconWindowPrecipitationRate(
  current: IconRecord | undefined,
  previous: IconRecord | undefined,
  startHour: number,
  endHour: number,
  index: number,
): IconPrecipitationWindow | null {
  if (!current) throw new IconAdapterError('precip-missing', 'ICON precipitation current record is unavailable');
  requireConsecutiveInitAccumulations(current, previous, startHour, endHour);
  const value = current.values[index];
  if (!finite(value)) return null;
  const prior = startHour === 0 ? 0 : previous?.values[index];
  if (!finite(prior)) return null;
  const amount = value - prior;
  const currentError = finite(current.metadata.packingError) ? current.metadata.packingError : 0.02;
  const previousError = previous && finite(previous.metadata.packingError) ? previous.metadata.packingError : 0;
  const tolerance = startHour === 0 ? currentError + 1e-9 : currentError + previousError + 1e-9;
  if (amount < -tolerance) throw new IconAdapterError('precip-reset', 'ICON precipitation accumulation decreases beyond packing tolerance');
  const mm = Math.max(0, amount);
  return { mm, mmPerHour: mm / (endHour - startHour) };
}
