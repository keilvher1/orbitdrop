// Minimal encoders for the bilevel PDF fixtures (CCITT G4 and JBIG2 MMR images), so
// make-static-fixtures.mjs can write them without external tools. Not used at runtime.
//
// encodeG4 writes ITU-T T.6 (Group 4, K < 0) using horizontal mode only: every coding line is
// a sequence of "001 + white run + black run" pairs, which is valid T.6 that every decoder
// accepts (the 2D vertical/pass modes are only a compression optimisation). Runs use the
// Modified Huffman tables of T.4 (terminating codes 0–63, make-up codes 64–1728).
// The bitmap is row-major, 1 = black, `width` × `height`.

const WHITE_TERM = [
  '00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
  '101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000', '00000010', '00000011', '00011010',
  '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001', '00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010',
  '00001011', '01010010', '01010011', '01010100', '01010101', '00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100',
];
const WHITE_MAKEUP = [
  '11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101', '011010010', '011010011',
  '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000', '010011001', '010011010', '011000', '010011011',
];
const BLACK_TERM = [
  '0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111', '000011000',
  '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111', '00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001',
  '000001101010', '000001101011', '000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010', '000011011011', '000001010100', '000001010101', '000001010110', '000001010111',
  '000001100100', '000001100101', '000001010010', '000001010011', '000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100', '000001011010', '000001100110', '000001100111',
];
const BLACK_MAKEUP = [
  '0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101', '0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010',
  '0000001110011', '0000001110100', '0000001110101', '0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011', '0000001100100', '0000001100101',
];
const EOL = '000000000001';

function runCode(length, black) {
  if (length > 1728 + 63) throw new Error(`run ${length} is too long for this encoder`);
  let code = '';
  if (length >= 64) {
    code += (black ? BLACK_MAKEUP : WHITE_MAKEUP)[Math.floor(length / 64) - 1];
    length %= 64;
  }
  return code + (black ? BLACK_TERM : WHITE_TERM)[length];
}

function bitsToBytes(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i += 1) if (bits[i] === '1') out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

/** T.6 (Group 4) data for a bitmap, horizontal mode only, ending with EOFB. */
export function encodeG4(bitmap, width, height) {
  let bits = '';
  for (let y = 0; y < height; y += 1) {
    const row = bitmap.subarray(y * width, (y + 1) * width);
    let a0 = 0;
    while (a0 < width) {
      // white run from a0, then black run
      let a1 = a0;
      while (a1 < width && row[a1] === 0) a1 += 1;
      let a2 = a1;
      while (a2 < width && row[a2] === 1) a2 += 1;
      bits += `001${runCode(a1 - a0, false)}${runCode(a2 - a1, true)}`;
      a0 = a2;
    }
  }
  bits += EOL + EOL;
  return bitsToBytes(bits);
}

/**
 * JBIG2 embedded stream (as in a PDF /JBIG2Decode image) holding one page: page information,
 * an immediate generic region coded with MMR (the same T.6 data) and end of page.
 */
export function jbig2MmrStream(g4, width, height) {
  const segment = (number, type, data) => {
    const header = new Uint8Array(11);
    const view = new DataView(header.buffer);
    view.setUint32(0, number);
    header[4] = type; // segment type, 1-byte page association
    header[5] = 0; // no referred-to segments
    header[6] = 1; // page 1
    view.setUint32(7, data.length);
    return [header, data];
  };
  const pageInfo = new Uint8Array(19);
  new DataView(pageInfo.buffer).setUint32(0, width);
  new DataView(pageInfo.buffer).setUint32(4, height);
  const region = new Uint8Array(18 + g4.length);
  new DataView(region.buffer).setUint32(0, width);
  new DataView(region.buffer).setUint32(4, height);
  region[16] = 0; // region flags: OR combination
  region[17] = 0x01; // generic region flags: MMR
  region.set(g4, 18);
  const parts = [...segment(0, 48, pageInfo), ...segment(1, 38, region), ...segment(2, 49, new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** The fixture bitmap (1 = black): a box, a diagonal band and a 1-pixel grid line — asymmetric. */
export function bilevelPattern(width = 96, height = 48) {
  const bitmap = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const box = x >= 6 && x < 30 && y >= 4 && y < 20;
      const band = Math.abs(x - 2 * y - 40) < 3 && x >= 40;
      const line = y === 40 && x >= 10 && x < 86;
      if (box || band || line) bitmap[y * width + x] = 1;
    }
  }
  return { bitmap, width, height };
}
