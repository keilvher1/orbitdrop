/**
 * Generated tray glyph used when the packaged icons are missing (dev builds):
 * an "orbit" ring with a satellite dot, anti-aliased. On macOS it is used as a
 * template image (black + alpha, the OS tints it); on Windows it is drawn in
 * the accent colour.
 */
export function drawTrayGlyph(size: number, rgb: readonly [number, number, number] = [0, 0, 0]): Uint8Array {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  const ringRadius = size * 0.34;
  const ringHalf = Math.max(0.6, size * 0.065);
  const dotRadius = size * 0.13;
  const satRadius = size * 0.1;
  const satAngle = -Math.PI / 4;
  const satX = c + ringRadius * Math.cos(satAngle);
  const satY = c + ringRadius * Math.sin(satAngle);
  const samples = 4;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      let covered = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const px = x + (sx + 0.5) / samples;
          const py = y + (sy + 0.5) / samples;
          const r = Math.hypot(px - c, py - c);
          const onRing = Math.abs(r - ringRadius) <= ringHalf;
          const onDot = r <= dotRadius;
          const onSat = Math.hypot(px - satX, py - satY) <= satRadius;
          if (onRing || onDot || onSat) covered += 1;
        }
      }
      const i = (y * size + x) * 4;
      data[i] = rgb[0];
      data[i + 1] = rgb[1];
      data[i + 2] = rgb[2];
      data[i + 3] = Math.round((covered / (samples * samples)) * 255);
    }
  }
  return data;
}
