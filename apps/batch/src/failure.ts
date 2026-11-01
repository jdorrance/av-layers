/** Small provider-neutral diagnostic: bounded before serialization, without invoking detail getters. */
export function failureReason(error: unknown) {
  const own = (value: unknown, key: string): unknown => value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined;
  const text = (value: unknown, fallback: string, maximum: number): string => typeof value === 'string' ? value.slice(0, maximum) : fallback;
  const result: { name: string; message: string; code?: string; details?: unknown; detailsTruncated?: boolean } = {
    name: text(own(error, 'name'), error instanceof Error ? error.name.slice(0, 128) : 'Error', 128),
    message: text(own(error, 'message'), typeof error === 'string' ? error.slice(0, 2048) : 'Unknown failure', 2048)
  };
  const code = own(error, 'code');
  if (typeof code === 'string') result.code = code.slice(0, 128);
  const details = own(error, 'details');
  if (details === undefined) return result;
  let remaining = 32, truncated = false;
  const seen = new WeakSet<object>();
  const bounded = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 3) { truncated = true; return '[omitted]'; }
    if (typeof value === 'string') { if (value.length > 256) truncated = true; return value.slice(0, 256); }
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value !== 'object') { truncated = true; return '[unsupported]'; }
    if (seen.has(value)) { truncated = true; return '[circular]'; }
    seen.add(value);
    if (Array.isArray(value)) {
      const output: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        if (remaining <= 0) { truncated = true; break; }
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor || !('value' in descriptor)) { truncated = true; output.push('[omitted]'); remaining--; }
        else output.push(bounded(descriptor.value, depth + 1));
      }
      return output;
    }
    const output: Record<string, unknown> = Object.create(null);
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (remaining <= 0) { truncated = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) { truncated = true; continue; }
      if (key.length > 64) truncated = true;
      output[key.slice(0, 64)] = bounded(descriptor.value, depth + 1);
    }
    return output;
  };
  result.details = bounded(details, 0);
  if (truncated) result.detailsTruncated = true;
  return result;
}
