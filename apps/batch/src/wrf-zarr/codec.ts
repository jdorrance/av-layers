import { constants, zstdDecompressSync } from 'node:zlib';
import { registry, type ArrayMetadata, type CodecMetadata } from 'zarrita';

const name = 'av-wrf-bounded-zstd';
registry.set(name, async () => ({
  fromConfig(_config, meta) {
    const length = meta.shape.reduce((size, count) => size * count, 4);
    return {
      kind: 'bytes_to_bytes',
      encode() { throw new Error('WRF codec is read-only'); },
      decode(bytes: Uint8Array) {
        const decoded = zstdDecompressSync(bytes, {
          maxOutputLength: length, params: { [constants.ZSTD_d_windowLogMax]: Math.ceil(Math.log2(length)) }
        });
        if (decoded.byteLength !== length) throw new Error('WRF Zarr decompressed chunk size mismatch');
        return decoded;
      }
    };
  }
}));

/** Preserve admitted metadata and select bounded native decompression for its float32 chunks. */
export function decodingMetadata(metadata: ArrayMetadata<'float32'>): ArrayMetadata<'float32'> {
  return { ...metadata, codecs: metadata.codecs.map(codec => ({ ...codec, configuration: {
    ...codec.configuration, codecs: (codec.configuration.codecs as CodecMetadata[]).map(inner =>
      inner.name === 'zstd' ? { ...inner, name } : inner)
  } })) };
}
