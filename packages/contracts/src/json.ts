/** Publication and serving share one admission policy; producers cannot emit unreadable metadata. */
export const MAX_POINTER_BYTES = 128 * 1024;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_PROVENANCE_BYTES = 4 * 1024 * 1024;
export const MAX_METADATA_JSON_TOKENS = 8192;
export const MAX_MANIFEST_JSON_TOKENS = 16_384;
export const MAX_PROVENANCE_JSON_TOKENS = 262_144;
export const MAX_JSON_CONTAINER_ENTRIES = 256;
export class ResourceLimitError extends Error {}

/** Bound nesting and structural tokens before TextDecoder or JSON.parse allocates strings or an object graph. */
export function parseBoundedJson(bytes: Uint8Array, maxTokens = MAX_METADATA_JSON_TOKENS, maxContainerEntries = MAX_JSON_CONTAINER_ENTRIES): unknown {
  let string = false, escaped = false, depth = 0, tokens = 0;
  const containers: { kind: number; entries: number }[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i]!;
    if (string) {
      if (escaped) escaped = false;
      else if (byte === 0x5c) escaped = true;
      else if (byte === 0x22) string = false;
    } else if (byte === 0x22) {
      string = true;
    } else if (byte === 0x7b || byte === 0x7d || byte === 0x5b || byte === 0x5d || byte === 0x2c || byte === 0x3a) {
      if (++tokens > maxTokens) throw new ResourceLimitError('JSON structure exceeds object budget');
      if (byte === 0x7b || byte === 0x5b) { depth++; containers.push({ kind: byte, entries: 0 }); }
      if (byte === 0x7d || byte === 0x5d) { depth--; containers.pop(); }
      const container = containers.at(-1);
      if (container && ((byte === 0x3a && container.kind === 0x7b) || (byte === 0x2c && container.kind === 0x5b))) {
        if (++container.entries > maxContainerEntries - (container.kind === 0x5b ? 1 : 0)) throw new ResourceLimitError('JSON container exceeds property budget');
      }
      if (depth > 32) throw new ResourceLimitError('JSON nesting exceeds object budget');
    }
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

/** Validate serialized bytes, including object-graph limits, before committing metadata. */
export function encodeBoundedJson(value: unknown, limit: number, maxTokens = MAX_METADATA_JSON_TOKENS): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > limit) throw new ResourceLimitError('JSON exceeds byte budget');
  parseBoundedJson(bytes, maxTokens);
  return bytes;
}

/** Compare JSON-compatible values structurally without depending on object property insertion order. */
export function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) {
    return Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object' || Array.isArray(right)) return false;
  const entries = Object.entries(left).filter(([, value]) => value !== undefined);
  const fields = right as Record<string, unknown>;
  const rightKeys = Object.keys(fields).filter(key => fields[key] !== undefined);
  return entries.length === rightKeys.length &&
    entries.every(([key, value]) => Object.hasOwn(fields, key) && sameJsonValue(value, fields[key]));
}
