import { countRead, MaterializedReads, type WaitContext, readBoundedStream, readObjectBytes, ResourceLimitError } from './resources';
import { Compression, EtagMismatch, PMTiles, ResolvedValueCache, TileType, type RangeResponse, type Source } from 'pmtiles';

const MAX_ARCHIVE_RANGE_BYTES = 1024 * 1024;
export async function decompress(buffer: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (buffer.byteLength > MAX_ARCHIVE_RANGE_BYTES) throw new ResourceLimitError('Archive range exceeds byte budget');
  if (compression === Compression.None) return buffer;
  if (compression === Compression.Gzip) return (await readBoundedStream(new Response(buffer).body!.pipeThrough(new DecompressionStream('gzip')), MAX_ARCHIVE_RANGE_BYTES)).buffer as ArrayBuffer;
  throw new Error('Unsupported PMTiles compression');
}

async function decompressDirectory(buffer: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  const result = await decompress(buffer, compression), bytes = new Uint8Array(result);
  // The PMTiles directory begins with an entry-count varint. Bound decoded object allocation too.
  let count = 0, multiplier = 1;
  for (let i = 0; i < Math.min(bytes.length, 8); i++) {
    count += (bytes[i] & 127) * multiplier;
    if (count > 16_384) throw new ResourceLimitError('PMTiles directory entry budget exceeded');
    if (!(bytes[i] & 128)) return result;
    multiplier *= 128;
  }
  throw new Error('Invalid PMTiles directory count');
}
export class DirectoryCache extends ResolvedValueCache {
  constructor(private readonly byteBudget = 4 * 1024 * 1024, maxEntries = 256) { super(maxEntries, undefined, decompressDirectory); }
  override prune(): void {
    const ordered = [...this.cache].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const weight = (data: typeof ordered[number][1]['data']) => Array.isArray(data) ? data.length * 96 : data instanceof ArrayBuffer ? data.byteLength : 512;
    let bytes = ordered.reduce((sum, [, value]) => sum + weight(value.data), 0);
    for (const [key, value] of ordered) {
      if (this.cache.size <= this.maxCacheEntries && bytes <= this.byteBudget) break;
      this.cache.delete(key); bytes -= weight(value.data);
    }
  }
}
const cache = new DirectoryCache();
const bucketIds = new WeakMap<object, number>();
let nextBucketId = 0;

export class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string, private ctx?: WaitContext, private signal?: AbortSignal) {}
  getKey(): string {
    if (!bucketIds.has(this.bucket)) bucketIds.set(this.bucket, ++nextBucketId);
    return `${bucketIds.get(this.bucket)}:${this.key}`;
  }
  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_ARCHIVE_RANGE_BYTES) throw new ResourceLimitError('Invalid or oversized archive range');
    countRead(this.ctx);
    const object = await this.bucket.get(this.key, { range: { offset, length }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (!object) throw new Error('Archive not found');
    if (!('body' in object)) throw new EtagMismatch();
    return { data: (await readObjectBytes(object, length, true, this.ctx, this.signal ?? _signal)).buffer as ArrayBuffer, etag: object.etag, cacheControl: object.httpMetadata?.cacheControl, expires: object.httpMetadata?.cacheExpiry?.toISOString() };
  }
}

const tileReads = new WeakMap<R2Bucket, MaterializedReads<ArrayBuffer>>();
export async function readTile(bucket: R2Bucket, key: string, z: number, x: number, y: number, ctx?: WaitContext): Promise<ArrayBuffer> {
  let reads = tileReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(4); tileReads.set(bucket, reads); }
  return reads.run(`${key}:${z}:${x}:${y}`, signal => loadTile(bucket, key, z, x, y, ctx, signal), ctx);
}
async function loadTile(bucket: R2Bucket, key: string, z: number, x: number, y: number, ctx?: WaitContext, signal?: AbortSignal): Promise<ArrayBuffer> {
  const archive = new PMTiles(new R2Source(bucket, key, ctx, signal), cache, decompress);
  const header = await archive.getHeader();
  if (header.tileType !== TileType.Webp || header.tileCompression !== Compression.None || ![Compression.None, Compression.Gzip].includes(header.internalCompression)) throw new Error('Unsupported PMTiles archive');
  const tile = await archive.getZxy(z, x, y);
  if (!tile) throw new Error('Expected tile missing');
  return tile.data;
}
