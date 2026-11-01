import type { Manifest } from './index.ts';

export interface FrameLike {
  id: string;
  validTime: string;
  intervalStart: string;
  intervalEnd: string;
}

export interface DatasetRange {
  startMs: number;
  endMs: number;
}

export interface FrameBadge {
  kind: 'explicit' | 'in-frame' | 'off-frame' | 'expired';
  text: string;
}

export const HOST_MATCH_TOLERANCE_MS = 1000;

export function frameTime(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new RangeError(`Invalid frame timestamp: ${value}`);
  return parsed;
}

export function selectExplicitFrame<T extends FrameLike>(frames: readonly T[], id: string): T | null {
  return frames.find(frame => frame.id === id) ?? null;
}

export function matchHostFrame<T extends FrameLike>(frames: readonly T[], timestampMs: number, toleranceMs = HOST_MATCH_TOLERANCE_MS): T | null {
  if (!Number.isFinite(timestampMs)) return null;
  let best: T | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const frame of frames) {
    const distance = Math.abs(frameTime(frame.validTime) - timestampMs);
    if (distance <= toleranceMs && distance < bestDistance) {
      best = frame;
      bestDistance = distance;
    }
  }
  return best;
}

export function datasetRange(frames: readonly FrameLike[]): DatasetRange | null {
  if (frames.length === 0) return null;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const frame of frames) {
    const intervalStart = Date.parse(frame.intervalStart);
    const intervalEnd = Date.parse(frame.intervalEnd);
    if (!Number.isFinite(intervalStart) || !Number.isFinite(intervalEnd) || intervalEnd <= intervalStart) return null;
    start = Math.min(start, intervalStart);
    end = Math.max(end, intervalEnd);
  }
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? { startMs: start, endMs: end } : null;
}

export function syncTimestampForFrame(frame: FrameLike, range: DatasetRange | null): number | null {
  if (!range || !Number.isFinite(range.startMs) || !Number.isFinite(range.endMs) || range.endMs < range.startMs) return null;
  const timestamp = frameTime(frame.validTime);
  if (timestamp < range.startMs || timestamp > range.endMs) return null;
  return timestamp;
}

export function frameBadge(selected: FrameLike | null, hostMatch: FrameLike | null, hostTimestampMs: number | null, expired = false): FrameBadge {
  if (expired) return { kind: 'expired', text: 'Build expired — overlay removed' };
  if (!selected) return { kind: 'explicit', text: 'No frame selected' };
  if (hostMatch && hostMatch.id === selected.id) {
    return { kind: 'in-frame', text: `Host frame ${selected.id} · ${selected.validTime}` };
  }
  if (hostTimestampMs !== null && !hostMatch) {
    const time = new Date(hostTimestampMs).toISOString();
    return { kind: 'off-frame', text: `Host time ${time} is off-frame — keeping ${selected.id}` };
  }
  return { kind: 'explicit', text: `Explicit frame ${selected.id} · ${selected.validTime}` };
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function watchBuildExpiry(expiresAtMs: number, expire: () => void, targets: EventTarget[]): () => void {
  if (!Number.isFinite(expiresAtMs)) throw new RangeError('Invalid expiry deadline');
  let fired = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    if (fired) return;
    const remaining = expiresAtMs - Date.now();
    if (remaining <= 0) {
      fired = true;
      expire();
      return;
    }
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(check, Math.min(2_147_000_000, remaining));
  };
  const events = ['visibilitychange', 'pageshow', 'focus'];
  for (const target of targets) for (const event of events) target.addEventListener(event, check);
  check();
  return () => {
    fired = true;
    if (timer !== null) clearTimeout(timer);
    for (const target of targets) for (const event of events) target.removeEventListener(event, check);
  };
}

/** Forecast usefulness is independent of how long its artifacts are retained. */
export function forecastHorizonNotice(manifest: Pick<Manifest, 'frames'>, nowMs = Date.now()): string | null {
  if (manifest.frames.length === 0) return null;
  const endMs = Math.max(...manifest.frames.map(frame => frameTime(frame.validTime)));
  return nowMs >= endMs
    ? `Forecast ended at ${new Date(endMs).toISOString()} — update overdue. Showing historical forecast.`
    : null;
}

export function buildAgeMs(createdAt: string, now = Date.now()): number {
  return Math.max(0, now - frameTime(createdAt));
}
