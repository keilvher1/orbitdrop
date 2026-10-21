/**
 * Generated images for the dev harness (no assets, no network). Each returns a
 * canvas; `canvasUrl` turns it into a blob: URL (allowed by the CSP).
 * In environments without a canvas backend (jsdom) a 1×1 PNG is used instead.
 */

export const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=';

export function makeCanvas(width: number, height: number): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  return ctx && typeof (ctx as CanvasRenderingContext2D).fillRect === 'function' ? canvas : null;
}

export function ctx2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d context unavailable');
  return ctx;
}

export async function canvasUrl(canvas: HTMLCanvasElement | null, type = 'image/png', quality?: number): Promise<{ url: string; bytes: number }> {
  if (canvas === null) return { url: BLANK_PNG, bytes: 68 };
  const blob = await new Promise<Blob | null>((resolve) => {
    try {
      canvas.toBlob(resolve, type, quality);
    } catch {
      resolve(null);
    }
  });
  if (blob === null) return { url: BLANK_PNG, bytes: 68 };
  return { url: URL.createObjectURL(blob), bytes: blob.size };
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Apple SD Gothic Neo', 'Malgun Gothic', sans-serif";

/** A printed page like "Page 001.pdf" in the reference recording (letter, portrait). */
export function documentImage(width: number, height: number): HTMLCanvasElement | null {
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = ctx2d(canvas);
  const s = width / 850;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#1f2328';
  ctx.font = `700 ${18 * s}px ${FONT}`;
  ctx.fillText('Title: Nurse Turnover: Retention of the Staff', 70 * s, 92 * s);
  let y = 126 * s;
  let seed = 7;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  ctx.font = `${11.5 * s}px ${FONT}`;
  for (let line = 0; line < 64 && y < height - 70 * s; line += 1) {
    if (line % 12 === 11) {
      y += 14 * s;
      ctx.font = `700 ${12.5 * s}px ${FONT}`;
      ctx.fillStyle = '#1f2328';
      ctx.fillText(`Section ${Math.ceil(line / 12)}. Findings and implications`, 70 * s, y);
      ctx.font = `${11.5 * s}px ${FONT}`;
      y += 22 * s;
      continue;
    }
    ctx.fillStyle = '#4b5563';
    const words = 9 + Math.floor(rand() * 5);
    let x = 70 * s;
    const right = width - 70 * s;
    for (let w = 0; w < words; w += 1) {
      const len = (24 + rand() * 46) * s;
      if (x + len > right) break;
      ctx.fillRect(x, y - 8 * s, len, 7 * s);
      x += len + 9 * s;
    }
    y += 19 * s;
  }
  ctx.fillStyle = '#9ca3af';
  ctx.font = `${10 * s}px ${FONT}`;
  ctx.fillText('1', width / 2, height - 36 * s);
  return canvas;
}

/** A landscape "photo": sunset sky, sun, mountains, lake, a signpost with Korean text. */
export function photoImage(width: number, height: number): HTMLCanvasElement | null {
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = ctx2d(canvas);
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.62);
  sky.addColorStop(0, '#2b4c8c');
  sky.addColorStop(0.55, '#f08a5d');
  sky.addColorStop(1, '#ffd29d');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  // Sun
  const sun = ctx.createRadialGradient(width * 0.68, height * 0.48, 0, width * 0.68, height * 0.48, height * 0.2);
  sun.addColorStop(0, 'rgba(255, 244, 214, 1)');
  sun.addColorStop(0.35, 'rgba(255, 214, 150, 0.9)');
  sun.addColorStop(1, 'rgba(255, 180, 120, 0)');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);
  // Mountains
  const ridge = (base: number, amp: number, color: string, phase: number) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += width / 60) {
      const y = base - amp * (0.55 + 0.45 * Math.sin(x / (width / 7) + phase) * Math.cos(x / (width / 3.1) + phase * 0.7));
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  };
  ridge(height * 0.6, height * 0.18, '#6b4a6e', 0.4);
  ridge(height * 0.66, height * 0.12, '#3f3456', 1.7);
  // Lake
  const lake = ctx.createLinearGradient(0, height * 0.66, 0, height);
  lake.addColorStop(0, '#f2a76b');
  lake.addColorStop(1, '#2d3d6b');
  ctx.fillStyle = lake;
  ctx.fillRect(0, height * 0.66, width, height * 0.34);
  ctx.fillStyle = 'rgba(255, 236, 200, 0.55)';
  for (let i = 0; i < 9; i += 1) {
    const w = width * (0.16 - i * 0.012);
    ctx.fillRect(width * 0.68 - w / 2, height * (0.69 + i * 0.03), w, height * 0.006);
  }
  // Signpost
  const s = width / 1600;
  ctx.fillStyle = '#4a3426';
  ctx.fillRect(250 * s, 760 * s, 14 * s, 300 * s);
  ctx.fillStyle = '#fff6ee';
  ctx.strokeStyle = '#4a3426';
  ctx.lineWidth = 6 * s;
  ctx.beginPath();
  ctx.roundRect(120 * s, 690 * s, 280 * s, 96 * s, 14 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#2b1d14';
  ctx.font = `700 ${40 * s}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('전망대 1.2km', 260 * s, 739 * s);
  return canvas;
}

/** Transparent PNG-like logo (for alpha / checkerboard views). */
export function logoImage(width: number, height: number): HTMLCanvasElement | null {
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = ctx2d(canvas);
  ctx.clearRect(0, 0, width, height);
  const r = Math.min(width, height) * 0.42;
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#ff8a4c');
  g.addColorStop(1, '#f2552c');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${r * 0.7}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OD', width / 2, height / 2);
  return canvas;
}

/** Background image the mock returns from pickBackgroundImage. */
export function patternImage(width: number, height: number): HTMLCanvasElement | null {
  const canvas = makeCanvas(width, height);
  if (!canvas) return null;
  const ctx = ctx2d(canvas);
  const g = ctx.createLinearGradient(0, 0, width, height);
  g.addColorStop(0, '#0f766e');
  g.addColorStop(1, '#a7f3d0');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  const step = Math.max(24, width / 14);
  for (let y = 0; y < height + step; y += step) {
    for (let x = (y / step) % 2 === 0 ? 0 : step / 2; x < width + step; x += step) {
      ctx.beginPath();
      ctx.arc(x, y, step * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  return canvas;
}
