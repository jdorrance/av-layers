import { getR2Object, countCacheHit, MaterializedReads, type WaitContext, readBoundedStream, readObjectBytes, ResourceLimitError } from './resources';
import { matchStorageBytes, storeStorageBytes } from './storage-cache';
import { Compression, EtagMismatch, PMTiles, ResolvedValueCache, TileType, type Header, type Entry, type RangeResponse, type Source } from 'pmtiles';

const MAX_ARCHIVE_RANGE_BYTES = 1024 * 1024;
const TILE_READ_CONCURRENCY = 8;
const TILE_READ_WAITERS = 128;
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
  override getHeader(source: Source): Promise<Header> { return super.getHeader(metadataSource(source)); }
  override getDirectory(source: Source, offset: number, length: number, header: Header, signal?: AbortSignal): Promise<Entry[]> {
    return super.getDirectory(metadataSource(source), offset, length, header, signal);
  }
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
const archiveRangeReads = new WeakMap<R2Bucket, MaterializedReads<RangeResponse>>();

interface ArchiveIdentity { sha256: string; expiresAt: string }
function metadataSource(source: Source): Source {
  return source instanceof R2Source ? { getKey: () => source.getKey(),
    getBytes: (offset, length, signal, etag) => source.getBytes(offset, length, signal, etag, true) } : source;
}

export class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string, private ctx?: WaitContext, private signal?: AbortSignal, private identity?: ArchiveIdentity) {}
  getKey(): string {
    if (!bucketIds.has(this.bucket)) bucketIds.set(this.bucket, ++nextBucketId);
    return `${bucketIds.get(this.bucket)}:${this.key}:${this.identity?.sha256 ?? ''}`;
  }
  async getBytes(offset: number, length: number, signal?: AbortSignal, etag?: string, metadata = false): Promise<RangeResponse> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length <= 0 || length > MAX_ARCHIVE_RANGE_BYTES) throw new ResourceLimitError('Invalid or oversized archive range');
    let reads = archiveRangeReads.get(this.bucket);
    if (!reads) { reads = new MaterializedReads(TILE_READ_CONCURRENCY, undefined, TILE_READ_WAITERS); archiveRangeReads.set(this.bucket, reads); }
    const waiterSignal = this.signal && signal ? AbortSignal.any([this.signal, signal]) : this.signal ?? signal;
    const sharedKey = metadata && this.identity && /^[a-f0-9]{64}$/.test(this.identity.sha256)
      ? `archive:${this.key}:${this.identity.sha256}:${offset}:${length}:${etag ?? ''}` : undefined;
    return reads.run(`${this.key}:${this.identity?.sha256 ?? ''}:${offset}:${length}:${etag ?? ''}:${metadata}`, async operationSignal => {
      const cached = sharedKey ? await matchStorageBytes(sharedKey, length, this.ctx, operationSignal) : undefined;
      if (cached && cached.until <= Date.parse(this.identity!.expiresAt) && (!etag || cached.etag === etag)) {
        countCacheHit(this.ctx);
        return { data: cached.bytes.buffer as ArrayBuffer, etag: cached.etag };
      }
      const object = await getR2Object(this.bucket, this.key, this.ctx, { range: { offset, length }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
      if (!object) throw new Error('Archive not found');
      if (!('body' in object)) throw new EtagMismatch();
      const bytes = await readObjectBytes(object, length, true, this.ctx, operationSignal);
      if (sharedKey) {
        const stored = storeStorageBytes(sharedKey, { bytes, etag: object.etag, until: Date.parse(this.identity!.expiresAt) }, this.ctx);
        if (this.ctx) this.ctx.waitUntil(stored); else await stored;
      }
      return { data: bytes.buffer as ArrayBuffer, etag: object.etag, cacheControl: object.httpMetadata?.cacheControl, expires: object.httpMetadata?.cacheExpiry?.toISOString() };
    }, this.ctx, waiterSignal);
  }
}

const tileReads = new WeakMap<R2Bucket, MaterializedReads<ArrayBuffer>>();
export async function readTile(bucket: R2Bucket, key: string, z: number, x: number, y: number, ctx?: WaitContext, waiterSignal?: AbortSignal, identity?: ArchiveIdentity): Promise<ArrayBuffer> {
  let reads = tileReads.get(bucket);
  if (!reads) { reads = new MaterializedReads(TILE_READ_CONCURRENCY, undefined, TILE_READ_WAITERS); tileReads.set(bucket, reads); }
  return reads.run(`${key}:${identity?.sha256 ?? ''}:${z}:${x}:${y}`, signal => loadTile(bucket, key, z, x, y, ctx, signal, identity), ctx, waiterSignal);
}
async function loadTile(bucket: R2Bucket, key: string, z: number, x: number, y: number, ctx?: WaitContext, signal?: AbortSignal, identity?: ArchiveIdentity): Promise<ArrayBuffer> {
  const archive = new PMTiles(new R2Source(bucket, key, ctx, signal, identity), cache, decompress);
  const header = await archive.getHeader();
  if (header.tileType !== TileType.Webp || header.tileCompression !== Compression.None || ![Compression.None, Compression.Gzip].includes(header.internalCompression)) throw new Error('Unsupported PMTiles archive');
  const tile = await archive.getZxy(z, x, y);
  if (!tile) throw new Error('Expected tile missing');
  return tile.data;
}
