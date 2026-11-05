/** Configured source clocks, URLs and copied index ownership. */
export function sourceCycle(value: string, hours: readonly number[]): string {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:00:00(?:\.000)?Z$/.test(value) || !Number.isFinite(date.getTime())
      || date.toISOString() !== value.replace(/(?:\.000)?Z$/, '.000Z') || !hours.includes(date.getUTCHours())) throw new RangeError('Cycle must identify a configured exact ISO UTC source hour');
  return date.toISOString();
}

export function sourceWindowStart(forecast: { intervalHours: number; statisticsResetHours: number | null }, hour: number): number {
  return forecast.statisticsResetHours === null ? 0 : Math.floor((hour - forecast.intervalHours) / forecast.statisticsResetHours) * forecast.statisticsResetHours;
}

export function recentSourceCycles(now: Date, hours: readonly number[], lag: number, count: number): string[] {
  const anchor = Math.floor((now.getTime() - lag * 3_600_000) / 3_600_000) * 3_600_000;
  if (!Number.isFinite(anchor)) throw new RangeError('Invalid discovery clock');
  const cycles: string[] = [];
  for (let offset = 0; offset < count * 24 && cycles.length < count; offset++) {
    const date = new Date(anchor - offset * 3_600_000);
    if (hours.includes(date.getUTCHours())) cycles.push(date.toISOString());
  }
  return cycles;
}

export function sourceUrl(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    if (values[key] === undefined) throw new Error(`Unknown source URL token ${key}`);
    return values[key];
  });
}

export function copySourceIndices(input: Uint32Array, cells: number): Uint32Array {
  if (!(input instanceof Uint32Array) || !input.length || input.length > cells) throw new RangeError('activeIndices must identify source cells');
  const result = new Uint32Array(input), seen = new Uint8Array(Math.ceil(cells / 8));
  for (const index of result) {
    const byte = index >> 3, bit = 1 << (index & 7);
    if (index >= cells || (seen[byte]! & bit)) throw new RangeError(`Invalid or duplicate active index ${index}`);
    seen[byte] |= bit;
  }
  return result;
}
