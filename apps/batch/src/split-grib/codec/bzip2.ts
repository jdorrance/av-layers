/**
 * Pure-TypeScript bzip2 (.bz2) decompressor for DWD Open Data GRIB2 streams.
 *
 * Implements the standard bzip2 format (stream header "BZh1".."BZh9",
 * block magic 0x314159265359, Huffman coding with up to 6 tables switching
 * every 50 symbols, Move-To-Front + RUNA/RUNB RLE1 decoding, inverse
 * Burrows-Wheeler Transform, byte-level RLE2 decoding, and big-endian CRC32
 * verification).
 */

const BZIP2_MAGIC_0 = 0x42; // 'B'
const BZIP2_MAGIC_1 = 0x5a; // 'Z'
const BZIP2_MAGIC_2 = 0x68; // 'h'
const MAX_GROUPS = 6;
const GROUP_SIZE = 50;
const MAX_ALPHA_SIZE = 258;
const MAX_CODE_LEN = 23;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let crc = (i << 24) >>> 0;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x80000000) !== 0 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
    }
    table[i] = crc;
  }
  return table;
})();

class BitReader {
  private readonly bytes: Uint8Array;
  private bytePos = 0;
  private bitBuf = 0;
  private bitCount = 0;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  readBits(n: number): number {
    while (this.bitCount < n) {
      if (this.bytePos >= this.bytes.length) {
        throw new Error("Unexpected end of bzip2 bitstream");
      }
      this.bitBuf = (this.bitBuf << 8) | this.bytes[this.bytePos]!;
      this.bytePos += 1;
      this.bitCount += 8;
    }
    this.bitCount -= n;
    const value = (this.bitBuf >>> this.bitCount) & ((1 << n) - 1);
    this.bitBuf &= (1 << this.bitCount) - 1;
    return value;
  }

  readBit(): number {
    if (this.bitCount === 0) {
      if (this.bytePos >= this.bytes.length) {
        throw new Error("Unexpected end of bzip2 bitstream");
      }
      this.bitBuf = this.bytes[this.bytePos]!;
      this.bytePos += 1;
      this.bitCount = 8;
    }
    this.bitCount -= 1;
    return (this.bitBuf >>> this.bitCount) & 1;
  }

  readUint32(): number {
    const high = this.readBits(16);
    const low = this.readBits(16);
    return ((high << 16) | low) >>> 0;
  }
}

interface HuffmanTable {
  minLen: number;
  maxLen: number;
  limit: Int32Array;
  base: Int32Array;
  perm: Uint16Array;
}

function buildHuffmanTable(lengths: Uint8Array, alphaSize: number): HuffmanTable {
  let minLen = MAX_CODE_LEN;
  let maxLen = 0;
  for (let i = 0; i < alphaSize; i += 1) {
    const len = lengths[i]!;
    if (len > maxLen) maxLen = len;
    if (len < minLen) minLen = len;
  }

  const limit = new Int32Array(MAX_CODE_LEN + 2);
  const base = new Int32Array(MAX_CODE_LEN + 2);
  const perm = new Uint16Array(MAX_ALPHA_SIZE);

  let pp = 0;
  for (let len = minLen; len <= maxLen; len += 1) {
    for (let i = 0; i < alphaSize; i += 1) {
      if (lengths[i] === len) {
        perm[pp] = i;
        pp += 1;
      }
    }
  }

  for (let i = 0; i < alphaSize; i += 1) {
    base[lengths[i]! + 1]! += 1;
  }
  for (let i = 1; i < MAX_CODE_LEN + 2; i += 1) {
    base[i]! += base[i - 1]!;
  }

  let vec = 0;
  for (let len = minLen; len <= maxLen; len += 1) {
    vec += base[len + 1]! - base[len]!;
    limit[len] = vec - 1;
    vec <<= 1;
  }
  for (let len = minLen + 1; len <= maxLen; len += 1) {
    base[len] = ((limit[len - 1]! + 1) << 1) - base[len]!;
  }

  return { minLen, maxLen, limit, base, perm };
}

function decodeHuffmanSymbol(reader: BitReader, table: HuffmanTable): number {
  let zn = table.minLen;
  let zvec = reader.readBits(zn);
  while (zvec > table.limit[zn]!) {
    zn += 1;
    if (zn > table.maxLen) {
      throw new Error("bzip2 Huffman code overrun");
    }
    zvec = (zvec << 1) | reader.readBit();
  }
  const idx = zvec - table.base[zn]!;
  if (idx < 0 || idx >= table.perm.length) {
    throw new Error("bzip2 invalid Huffman permutation index");
  }
  return table.perm[idx]!;
}

/**
 * Return true if the byte buffer begins with the bzip2 "BZh" header.
 */
export function isBzip2Compressed(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === BZIP2_MAGIC_0 &&
    bytes[1] === BZIP2_MAGIC_1 &&
    bytes[2] === BZIP2_MAGIC_2 &&
    bytes[3]! >= 0x31 &&
    bytes[3]! <= 0x39
  );
}

let scratchTt = new Uint32Array(0);

/**
 * Decompress a bzip2 buffer in pure TypeScript and verify block and stream CRCs.
 */
export function decompressBzip2(compressed: Uint8Array, maxOutputBytes: number): Uint8Array {
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0) throw new RangeError("Invalid bzip2 output byte limit");
  if (!isBzip2Compressed(compressed)) {
    throw new Error("Invalid bzip2 header: expected BZh[1-9]");
  }
  const blockSize100k = compressed[3]! - 0x30;
  const maxBlockBytes = blockSize100k * 100_000;
  if (scratchTt.length < maxBlockBytes) scratchTt = new Uint32Array(maxBlockBytes);
  const tt = scratchTt;

  const reader = new BitReader(compressed.subarray(4));
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let combinedCrc = 0;

  while (true) {
    const magicHigh = reader.readBits(24);
    const magicLow = reader.readBits(24);

    // End-of-stream magic 0x177245385090
    if (magicHigh === 0x177245 && magicLow === 0x385090) {
      const expectedStreamCrc = reader.readUint32();
      if (expectedStreamCrc !== combinedCrc) {
        throw new Error(
          `bzip2 stream CRC mismatch: expected 0x${expectedStreamCrc.toString(16)}, got 0x${combinedCrc.toString(16)}`
        );
      }
      break;
    }

    // Block header magic 0x314159265359
    if (magicHigh !== 0x314159 || magicLow !== 0x265359) {
      throw new Error(
        `Invalid bzip2 block magic: 0x${magicHigh.toString(16)}${magicLow.toString(16)}`
      );
    }

    const expectedBlockCrc = reader.readUint32();
    const blockRandomized = reader.readBit();
    if (blockRandomized !== 0) {
      throw new Error("Randomized bzip2 blocks are not supported");
    }
    const origPtr = reader.readBits(24);

    // Symbol map (16 groups of 16 bytes)
    const inUse16 = reader.readBits(16);
    const seqToUnseq = new Uint8Array(256);
    let nInUse = 0;
    for (let i = 0; i < 16; i += 1) {
      if ((inUse16 & (1 << (15 - i))) !== 0) {
        const groupBits = reader.readBits(16);
        for (let j = 0; j < 16; j += 1) {
          if ((groupBits & (1 << (15 - j))) !== 0) {
            seqToUnseq[nInUse] = i * 16 + j;
            nInUse += 1;
          }
        }
      }
    }
    if (nInUse === 0) {
      throw new Error("bzip2 block contains zero active symbols");
    }

    const alphaSize = nInUse + 2;
    const nGroups = reader.readBits(3);
    if (nGroups < 2 || nGroups > MAX_GROUPS) {
      throw new Error(`Invalid bzip2 Huffman group count: ${nGroups}`);
    }
    const nSelectors = reader.readBits(15);
    if (nSelectors === 0) {
      throw new Error("bzip2 block contains zero selectors");
    }

    const selectorMtf = new Uint8Array(MAX_GROUPS);
    for (let i = 0; i < nGroups; i += 1) {
      selectorMtf[i] = i;
    }
    const selectors = new Uint8Array(nSelectors);
    for (let i = 0; i < nSelectors; i += 1) {
      let j = 0;
      while (reader.readBit() !== 0) {
        j += 1;
        if (j >= nGroups) {
          throw new Error("bzip2 selector MTF index out of bounds");
        }
      }
      const v = selectorMtf[j]!;
      while (j > 0) {
        selectorMtf[j] = selectorMtf[j - 1]!;
        j -= 1;
      }
      selectorMtf[0] = v;
      selectors[i] = v;
    }

    // Read Huffman code lengths for each group
    const tables: HuffmanTable[] = [];
    for (let t = 0; t < nGroups; t += 1) {
      const lengths = new Uint8Array(alphaSize);
      let curr = reader.readBits(5);
      for (let i = 0; i < alphaSize; i += 1) {
        while (reader.readBit() !== 0) {
          curr += reader.readBit() === 0 ? 1 : -1;
          if (curr < 1 || curr > 20) {
            throw new Error(`Invalid bzip2 Huffman code length: ${curr}`);
          }
        }
        lengths[i] = curr;
      }
      tables.push(buildHuffmanTable(lengths, alphaSize));
    }

    // MTF state + frequency table for inverse BWT
    const mtfSymbol = new Uint8Array(256);
    for (let i = 0; i < nInUse; i += 1) {
      mtfSymbol[i] = i;
    }
    const unzftab = new Int32Array(256);

    const eob = nInUse + 1;
    let groupNo = -1;
    let groupPos = 0;
    let currentTable = tables[0]!;
    let nblock = 0;

    let nextSym = decodeHuffmanSymbol(reader, loadNextGroup());

    function loadNextGroup(): HuffmanTable {
      groupNo += 1;
      if (groupNo >= nSelectors) {
        throw new Error("bzip2 selector overrun");
      }
      groupPos = GROUP_SIZE - 1;
      currentTable = tables[selectors[groupNo]!]!;
      return currentTable;
    }

    function nextHuffmanSymbol(): number {
      if (groupPos === 0) {
        loadNextGroup();
      } else {
        groupPos -= 1;
      }
      return decodeHuffmanSymbol(reader, currentTable);
    }

    while (nextSym !== eob) {
      if (nextSym === 0 || nextSym === 1) {
        // RUNA (0) / RUNB (1) bijective base-2 run-length encoding of zeros
        let es = -1;
        let n = 1;
        do {
          if (nextSym === 0) {
            es += n;
          } else {
            es += 2 * n;
          }
          n <<= 1;
          nextSym = nextHuffmanSymbol();
        } while (nextSym === 0 || nextSym === 1);

        es += 1;
        const uc = seqToUnseq[mtfSymbol[0]!]!;
        unzftab[uc]! += es;
        if (nblock + es > maxBlockBytes) {
          throw new Error("bzip2 block overflow during RLE1");
        }
        while (es > 0) {
          tt[nblock] = uc;
          nblock += 1;
          es -= 1;
        }
      } else {
        if (nblock >= maxBlockBytes) {
          throw new Error("bzip2 block overflow");
        }
        const nn = nextSym - 1;
        const ucIndex = mtfSymbol[nn]!;
        for (let j = nn; j > 0; j -= 1) {
          mtfSymbol[j] = mtfSymbol[j - 1]!;
        }
        mtfSymbol[0] = ucIndex;
        const uc = seqToUnseq[ucIndex]!;
        unzftab[uc]! += 1;
        tt[nblock] = uc;
        nblock += 1;
        nextSym = nextHuffmanSymbol();
      }
    }

    if (origPtr < 0 || origPtr >= nblock) {
      throw new Error(`Invalid bzip2 BWT primary pointer: ${origPtr} (nblock=${nblock})`);
    }

    // Cumulative character frequencies for inverse BWT
    const cftab = new Int32Array(257);
    cftab[0] = 0;
    for (let i = 1; i <= 256; i += 1) {
      cftab[i] = cftab[i - 1]! + unzftab[i - 1]!;
    }
    for (let i = 0; i < nblock; i += 1) {
      const uc = tt[i]! & 0xff;
      tt[cftab[uc]!]! |= i << 8;
      cftab[uc]! += 1;
    }

    // Inverse BWT + RLE2 decoding + CRC32 computation
    let tPos = tt[origPtr]! >>> 8;
    let blockCrc = 0xffffffff;
    let stateOutCh = -1;
    let stateOutLen = 0;
    const remainingBytes = maxOutputBytes - totalLength;
    let outCap = Math.min(Math.max(nblock, 4096), remainingBytes);
    let outBuf = new Uint8Array(outCap);
    let outPos = 0;

    const emitByte = (byte: number): void => {
      if (outPos >= remainingBytes) throw new Error("bzip2 output exceeds byte limit");
      if (outPos >= outCap) {
        outCap = Math.min(outCap * 2, remainingBytes);
        const grown = new Uint8Array(outCap);
        grown.set(outBuf);
        outBuf = grown;
      }
      outBuf[outPos] = byte;
      outPos += 1;
      blockCrc = ((blockCrc << 8) ^ CRC32_TABLE[((blockCrc >>> 24) ^ byte) & 0xff]!) >>> 0;
    };

    const flushRun = (): void => {
      if (stateOutLen === 0) return;
      for (let k = 0; k < stateOutLen; k += 1) {
        emitByte(stateOutCh);
      }
    };

    for (let i = 0; i < nblock; i += 1) {
      const c = tt[tPos]! & 0xff;
      tPos = tt[tPos]! >>> 8;

      if (stateOutLen === 4) {
        const totalRun = 4 + c;
        for (let k = 0; k < totalRun; k += 1) {
          emitByte(stateOutCh);
        }
        stateOutLen = 0;
        stateOutCh = -1;
      } else if (c === stateOutCh) {
        stateOutLen += 1;
      } else {
        flushRun();
        stateOutCh = c;
        stateOutLen = 1;
      }
    }
    flushRun();

    blockCrc = (~blockCrc) >>> 0;
    if (blockCrc !== expectedBlockCrc) {
      throw new Error(
        `bzip2 block CRC mismatch: expected 0x${expectedBlockCrc.toString(16)}, got 0x${blockCrc.toString(16)}`
      );
    }

    combinedCrc = (((combinedCrc << 1) | (combinedCrc >>> 31)) ^ blockCrc) >>> 0;
    const chunk = outBuf.subarray(0, outPos);
    chunks.push(chunk);
    totalLength += chunk.length;
  }

  if (chunks.length === 1) {
    return chunks[0]!;
  }
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
