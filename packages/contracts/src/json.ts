/** Publication and serving share one admission policy; producers cannot emit unreadable metadata. */
export const MAX_POINTER_BYTES = 128 * 1024;
export const MAX_MANIFEST_BYTES = 512 * 1024;
export const MAX_PROVENANCE_BYTES = 1024 * 1024;
export const MAX_METADATA_JSON_TOKENS = 8192;
export const MAX_PROVENANCE_JSON_TOKENS = 65_536;
export class ResourceLimitError extends Error {}

/** Bound nesting and structural tokens before JSON.parse allocates an object graph. */
export function parseBoundedJson(bytes: Uint8Array, maxTokens = MAX_METADATA_JSON_TOKENS): unknown {
  const text = new TextDecoder().decode(bytes);
  let string = false, escaped = false, depth = 0, tokens = 0;
  const containers: { kind: string; entries: number }[] = [];
  for (const character of text) {
    if (string) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') string = false; }
    else if (character === '"') string = true;
    else if ('{}[],:'.includes(character)) {
      if (++tokens > maxTokens) throw new ResourceLimitError('JSON structure exceeds object budget');
      if (character === '{' || character === '[') { depth++; containers.push({ kind: character, entries: 0 }); }
      if (character === '}' || character === ']') { depth--; containers.pop(); }
      const container = containers.at(-1);
      if (container && ((character === ':' && container.kind === '{') || (character === ',' && container.kind === '['))) {
        if (++container.entries > (container.kind === '{' ? 256 : 255)) throw new ResourceLimitError('JSON container exceeds property budget');
      }
      if (depth > 32) throw new ResourceLimitError('JSON nesting exceeds object budget');
    }
  }
  return JSON.parse(text);
}

/** Validate serialized bytes, including object-graph limits, before committing metadata. */
export function encodeBoundedJson(value: unknown, limit: number, maxTokens = MAX_METADATA_JSON_TOKENS): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > limit) throw new ResourceLimitError('JSON exceeds byte budget');
  parseBoundedJson(bytes, maxTokens);
  return bytes;
}
