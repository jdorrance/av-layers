/**
 * Pure-TypeScript CCSDS 121.0-B-2 (Adaptive Entropy Coding / GRIB2 Data
 * Representation Template 5.42) decoder matching libaec / ecCodes.
 */

const AEC_DATA_SIGNED = 1;
const AEC_DATA_PREPROCESS = 8;
const AEC_RESTRICTED = 16;
const AEC_PAD_RSI = 32;

interface CcsdsDecodeOptions {
  readonly bitsPerSample: number;
  readonly blockSize: number;
  readonly rsi: number;
  readonly flags: number;
  readonly sampleCount: number;
}

const SE_MAX_M = 90;

/**
 * Precomputed Second-Extension lookup tables for m in 0..90:
 * - SE_SUM[m] = t = d1 + d2 (for t in 0..12)
 * - SE_BASE[m] = t * (t + 1) / 2
 * Then d2 = m - SE_BASE[m] and d1 = SE_SUM[m] - d2.
 */
const { SE_SUM, SE_BASE } = (() => {
  const sum = new Int32Array(SE_MAX_M + 1);
  const base = new Int32Array(SE_MAX_M + 1);
  let idx = 0;
  for (let group = 0; group <= 12; group += 1) {
    const tri = (group * (group + 1)) >> 1;
    for (let k = 0; k <= group && idx <= SE_MAX_M; k += 1) {
      sum[idx] = group;
      base[idx] = tri;
      idx += 1;
    }
  }
  return { SE_SUM: sum, SE_BASE: base };
})();

class AecBitReader {
  private readonly bytes: Uint8Array;
  private bytePos = 0;
  private acc = 0;
  private bitsLeft = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  private ensureBits(count: number): void {
    while (this.bitsLeft < count) {
      if (this.bytePos >= this.bytes.length) throw new Error('Truncated CCSDS payload');
      // A read needs at most 32 bits; the final refill retains at most seven extra.
      this.acc = this.acc * 256 + this.bytes[this.bytePos++]!;
      this.bitsLeft += 8;
    }
  }

  readBits(count: number): number {
    if (count === 0) return 0;
    this.ensureBits(count);
    this.bitsLeft -= count;
    const scale = 1 << this.bitsLeft;
    const value = Math.floor(this.acc / scale);
    this.acc -= value * scale;
    return value;
  }

  readBit(): number {
    return this.readBits(1);
  }

  /**
   * Read a Fundamental Sequence (FS) codeword: count of 0 bits before a 1 bit.
   */
  readFs(): number {
    let zeros = 0;
    while (this.readBit() === 0) {
      zeros += 1;
    }
    return zeros;
  }

  alignToByte(): void {
    // Refills are byte-sized, so only the current byte's remainder can be buffered.
    this.bitsLeft = 0;
    this.acc = 0;
  }
}

function resolveIdLength(bitsPerSample: number, flags: number): number {
  if (bitsPerSample <= 4 && (flags & AEC_RESTRICTED) !== 0) {
    return bitsPerSample <= 2 ? 1 : 2;
  }
  if (bitsPerSample <= 8) return 3;
  if (bitsPerSample <= 16) return 4;
  return 5;
}

/**
 * Decode a CCSDS 121.0-B-2 (AEC) compressed payload into unsigned/signed integer samples.
 */
export function decodeCcsdsSamples(
  payload: Uint8Array,
  options: CcsdsDecodeOptions
): Uint32Array {
  const { bitsPerSample, blockSize, rsi, flags, sampleCount } = options;
  if (bitsPerSample < 1 || bitsPerSample > 32) {
    throw new Error(`Unsupported CCSDS bitsPerSample: ${bitsPerSample}`);
  }
  if (blockSize <= 0 || rsi <= 0) {
    throw new Error(`Invalid CCSDS blockSize (${blockSize}) or rsi (${rsi})`);
  }

  const out = new Uint32Array(sampleCount);
  if (sampleCount === 0) {
    return out;
  }

  const reader = new AecBitReader(payload);
  const idLen = resolveIdLength(bitsPerSample, flags);
  const maxId = (1 << idLen) - 1;
  const preprocess = (flags & AEC_DATA_PREPROCESS) !== 0;
  const signedData = (flags & AEC_DATA_SIGNED) !== 0;
  const padRsi = (flags & AEC_PAD_RSI) !== 0;

  const rsiCapacity = rsi * blockSize;
  const rsiBuffer = new Uint32Array(rsiCapacity + blockSize);
  const xmax = bitsPerSample === 32 ? 0xffffffff : ((1 << bitsPerSample) - 1) >>> 0;
  const med = ((xmax >>> 1) + 1) >>> 0;
  const signBit = bitsPerSample === 32 ? 0x80000000 : (1 << (bitsPerSample - 1)) >>> 0;

  let outPos = 0;

  while (outPos < sampleCount) {
    const remainingTotal = sampleCount - outPos;
    const rsiSamplesTarget = Math.min(rsiCapacity, remainingTotal);
    let rsiPos = 0;

    while (rsiPos < rsiSamplesTarget) {
      const isFirstBlockInRsi = rsiPos === 0;
      const hasRef = preprocess && isFirstBlockInRsi ? 1 : 0;
      const id = reader.readBits(idLen);

      if (id === maxId) {
        // Uncompressed block: reads up to blockSize raw N-bit samples directly
        const count = Math.min(blockSize, rsiSamplesTarget - rsiPos);
        for (let i = 0; i < count; i += 1) {
          rsiBuffer[rsiPos] = reader.readBits(bitsPerSample);
          rsiPos += 1;
        }
      } else if (id >= 1) {
        // Split-sample block with k = id - 1 LSB bits.
        // In CCSDS 121.0-B-2, a block always encodes (blockSize - hasRef) FS codewords
        // followed by (blockSize - hasRef) k-bit LSBs, even for the trailing partial block.
        const k = id - 1;
        if (hasRef === 1 && rsiPos < rsiSamplesTarget) {
          rsiBuffer[rsiPos] = reader.readBits(bitsPerSample);
          rsiPos += 1;
        }
        const fullBlockCoded = blockSize - hasRef;
        const codedCount = Math.min(fullBlockCoded, rsiSamplesTarget - rsiPos);
        const startIdx = rsiPos;
        for (let i = 0; i < fullBlockCoded; i += 1) {
          const fs = reader.readFs();
          if (i < codedCount) {
            rsiBuffer[startIdx + i] = k > 0 ? (fs << k) >>> 0 : fs >>> 0;
          }
        }
        if (k > 0) {
          for (let i = 0; i < codedCount; i += 1) {
            rsiBuffer[startIdx + i] = (rsiBuffer[startIdx + i]! + reader.readBits(k)) >>> 0;
          }
        }
        rsiPos += codedCount;
      } else {
        // Low-entropy option (id === 0): read 1 bit to select zero-block (0) or second-extension (1)
        const subId = reader.readBit();
        if (hasRef === 1 && rsiPos < rsiSamplesTarget) {
          rsiBuffer[rsiPos] = reader.readBits(bitsPerSample);
          rsiPos += 1;
        }
        if (subId === 1) {
          // Second-extension (SE) coding
          let i = hasRef;
          while (i < blockSize && rsiPos < rsiSamplesTarget) {
            const m = reader.readFs();
            if (m > SE_MAX_M) {
              throw new Error(`CCSDS second-extension symbol out of range: ${m}`);
            }
            const d2 = m - SE_BASE[m]!;
            if ((i & 1) === 0) {
              const d1 = SE_SUM[m]! - d2;
              rsiBuffer[rsiPos] = d1 >>> 0;
              rsiPos += 1;
              i += 1;
            }
            if (rsiPos < rsiSamplesTarget) {
              rsiBuffer[rsiPos] = d2 >>> 0;
              rsiPos += 1;
            }
            i += 1;
          }
        } else {
          // Zero-block run-length coding
          const z = reader.readFs();
          let zeroBlocks: number;
          if (z + 1 === 5) {
            // ROS (Remainder of Segment): up to 64-block boundary or end of RSI
            const currentBlockIdx = Math.floor((rsiPos - hasRef) / blockSize);
            const blocksLeftInRsi = rsi - currentBlockIdx;
            const mod64 = currentBlockIdx & 63;
            const to64Boundary = 64 - mod64;
            zeroBlocks = Math.min(blocksLeftInRsi, to64Boundary);
          } else if (z + 1 > 5) {
            zeroBlocks = z;
          } else {
            zeroBlocks = z + 1;
          }
          const zeroSamples = Math.min(
            zeroBlocks * blockSize - hasRef,
            rsiSamplesTarget - rsiPos
          );
          rsiBuffer.fill(0, rsiPos, rsiPos + zeroSamples);
          rsiPos += zeroSamples;
        }
      }
    }

    // Postprocess (inverse DPCM mapper) for this RSI
    if (preprocess && rsiSamplesTarget > 0) {
      if (!signedData) {
        let x = rsiBuffer[0]! >>> 0;
        out[outPos] = x;
        for (let i = 1; i < rsiSamplesTarget; i += 1) {
          const d = rsiBuffer[i]! >>> 0;
          const lsb = d & 1;
          const half = ((d >>> 1) + lsb) >>> 0;
          const mask = (x & med) !== 0 ? xmax : 0;
          const theta = (mask ^ x) >>> 0;
          const delta = ((d >>> 1) ^ (-lsb >>> 0)) >>> 0;
          const unmapped = (x + delta) >>> 0;
          x = half > theta ? (d ^ mask) >>> 0 : unmapped & xmax;
          out[outPos + i] = x;
        }
      } else {
        let x = rsiBuffer[0]! >>> 0;
        if ((x & signBit) !== 0) {
          x = ((x ^ signBit) - signBit) | 0;
        }
        out[outPos] = x & xmax;
        const sMax = (xmax >>> 1) | 0;
        const sMin = ~sMax;
        for (let i = 1; i < rsiSamplesTarget; i += 1) {
          const d = rsiBuffer[i]! >>> 0;
          const lsb = d & 1;
          const half = (d >>> 1) + lsb;
          const delta = (d >>> 1) ^ -lsb;
          if (x >= 0) {
            const theta = sMax - x;
            x = half > theta ? sMax - d : (x + delta) | 0;
          } else {
            const theta = sMax + 1 + x;
            x = half > theta ? (d + sMin) | 0 : (x + delta) | 0;
          }
          out[outPos + i] = (x >>> 0) & xmax;
        }
      }
    } else {
      for (let i = 0; i < rsiSamplesTarget; i += 1) {
        out[outPos + i] = rsiBuffer[i]!;
      }
    }

    outPos += rsiSamplesTarget;
    if (padRsi) {
      reader.alignToByte();
    }
  }

  return out;
}
