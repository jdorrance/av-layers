export function dayKey(utcMs: number, offsetMinutes: number): string {
  return new Date(utcMs + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

export function dayLabel(key: string, todayKey: string): string {
  const day = Date.parse(`${key}T00:00:00Z`);
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  const diff = Math.round((day - today) / 86_400_000);
  if (diff === -1) return 'Yesterday';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  return new Date(day).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function clockLabel(validMs: number, offsetMinutes: number): string {
  const local = new Date(validMs + offsetMinutes * 60_000);
  const utc = new Date(validMs);
  const hhmm = (date: Date) => `${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}`;
  const sign = offsetMinutes >= 0 ? '+' : '−';
  const abs = Math.abs(offsetMinutes);
  const zone = `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${hhmm(local)} longitude time (${zone}) · ${hhmm(utc)} UTC`;
}

export function frameIndexFor(frames: readonly { validTime: string }[], requested: string | null, now: number): number {
  if (requested) {
    const exact = frames.findIndex(frame => frame.validTime === requested);
    if (exact >= 0) return exact;
    const target = Date.parse(requested);
    if (Number.isFinite(target)) {
      let best = 0;
      let distance = Number.POSITIVE_INFINITY;
      frames.forEach((frame, index) => {
        const delta = Math.abs(Date.parse(frame.validTime) - target);
        if (delta < distance) { best = index; distance = delta; }
      });
      return best;
    }
  }
  let best = 0;
  let bestAt = Number.NEGATIVE_INFINITY;
  frames.forEach((frame, index) => {
    const at = Date.parse(frame.validTime);
    if (at <= now && at >= bestAt) { best = index; bestAt = at; }
  });
  return best;
}
