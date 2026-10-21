/**
 * Read the pixel size of a JPEG from its SOF marker (no decoding). Used by the
 * smoke test to check that the conversion produced a real JPEG of the right
 * size without loading an image library in main.
 */
export function readJpegSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= data.length) {
    if (data[offset] !== 0xff) return null;
    const marker = data[offset + 1]!;
    if (marker === 0xff) {
      offset += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = (data[offset + 2]! << 8) | data[offset + 3]!;
    if (length < 2) return null;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > data.length) return null;
      const height = (data[offset + 5]! << 8) | data[offset + 6]!;
      const width = (data[offset + 7]! << 8) | data[offset + 8]!;
      return { width, height };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end / start of scan before any SOF
    offset += 2 + length;
  }
  return null;
}
