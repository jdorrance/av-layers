export function getBit(bits: Uint8Array, index: number): boolean {
  return Number.isSafeInteger(index) && index >= 0 && index < bits.length * 8 && (bits[index >> 3] & (1 << (index & 7))) !== 0;
}
export function setBit(bits: Uint8Array, index: number, value = true): void {
  if (!Number.isSafeInteger(index) || index < 0 || index >= bits.length * 8) throw new RangeError('bit index out of bounds');
  const i = index >> 3, bit = 1 << (index & 7);
  bits[i] = value ? bits[i] | bit : bits[i] & ~bit;
}
