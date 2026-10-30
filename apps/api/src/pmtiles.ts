import { Compression, EtagMismatch, PMTiles, ResolvedValueCache, TileType, type RangeResponse, type Source } from 'pmtiles';

async function decompress(buffer: ArrayBuffer, compression: Compression): Promise<ArrayBuffer> {
  if (compression === Compression.None) return buffer;
  if (compression === Compression.Gzip) return new Response(new Response(buffer).body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  throw new Error('Unsupported PMTiles compression');
}

const cache = new ResolvedValueCache(256, undefined, decompress);
const bucketIds = new WeakMap<object, number>();
let nextBucketId = 0;

class R2Source implements Source {
  constructor(private bucket: R2Bucket, private key: string) {}
  getKey(): string {
    if (!bucketIds.has(this.bucket)) bucketIds.set(this.bucket, ++nextBucketId);
    return `${bucketIds.get(this.bucket)}:${this.key}`;
  }
  async getBytes(offset: number, length: number, _signal?: AbortSignal, etag?: string): Promise<RangeResponse> {
    const object = await this.bucket.get(this.key, { range: { offset, length }, ...(etag ? { onlyIf: { etagMatches: etag } } : {}) });
    if (!object) throw new Error('Archive not found');
    if (!('body' in object)) throw new EtagMismatch();
    return { data: await object.arrayBuffer(), etag: object.etag, cacheControl: object.httpMetadata?.cacheControl, expires: object.httpMetadata?.cacheExpiry?.toISOString() };
  }
}

export async function readTile(bucket: R2Bucket, key: string, z: number, x: number, y: number): Promise<ArrayBuffer> {
  const archive = new PMTiles(new R2Source(bucket, key), cache, decompress);
  const header = await archive.getHeader();
  if (header.tileType !== TileType.Webp || header.tileCompression !== Compression.None || ![Compression.None, Compression.Gzip].includes(header.internalCompression)) throw new Error('Unsupported PMTiles archive');
  const tile = await archive.getZxy(z, x, y);
  if (!tile) throw new Error('Expected tile missing');
  return tile.data;
}
