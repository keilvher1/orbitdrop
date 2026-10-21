/**
 * Minimal one-page PDF (two filled rectangles, no fonts) for the smoke test:
 * enough to prove that PDF.js can render a page inside the processor worker.
 */
export function minimalPdf(widthPt: number, heightPt: number): Buffer {
  const half = widthPt / 2;
  const content = `1 0 0 rg 0 0 ${half} ${heightPt} re f\n0 0 1 rg ${half} 0 ${half} ${heightPt} re f\n`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}endstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Width/height from a PNG's IHDR chunk, or null if the data is not a PNG. */
export function readPngSize(data: Uint8Array): { width: number; height: number } | null {
  if (data.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((byte, i) => data[i] === byte)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (String.fromCharCode(data[12]!, data[13]!, data[14]!, data[15]!) !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
