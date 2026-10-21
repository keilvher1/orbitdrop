/**
 * Groups rectangles into clusters whose bounding boxes are pairwise disjoint
 * (after expanding by `gap`), so overlays and region decodes only cover the
 * areas that are actually used: two small arrows in opposite corners of a
 * 100 MP photo become two small tiles, not one canvas the size of the photo.
 * Because cluster boxes never intersect, anything drawn inside one cluster
 * cannot touch another, and members keep their original order.
 */

export interface PixelBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Cluster {
  readonly box: PixelBox;
  /** Indices of the member items, ascending (original order). */
  readonly members: readonly number[];
}

interface Mutable {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  members: number[];
}

function near(a: Mutable, b: Mutable, gap: number): boolean {
  return a.x0 - gap < b.x1 && b.x0 - gap < a.x1 && a.y0 - gap < b.y1 && b.y0 - gap < a.y1;
}

export function clusterBoxes(boxes: readonly (PixelBox | null)[], gap = 32): Cluster[] {
  let clusters: Mutable[] = [];
  boxes.forEach((b, i) => {
    if (b && b.width > 0 && b.height > 0) clusters.push({ x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height, members: [i] });
  });
  let merged = true;
  while (merged) {
    merged = false;
    const next: Mutable[] = [];
    for (const c of clusters) {
      const target = next.find((n) => near(n, c, gap));
      if (target) {
        target.x0 = Math.min(target.x0, c.x0);
        target.y0 = Math.min(target.y0, c.y0);
        target.x1 = Math.max(target.x1, c.x1);
        target.y1 = Math.max(target.y1, c.y1);
        target.members.push(...c.members);
        merged = true;
      } else {
        next.push({ ...c, members: [...c.members] });
      }
    }
    clusters = next;
  }
  return clusters.map((c) => ({
    box: { x: c.x0, y: c.y0, width: c.x1 - c.x0, height: c.y1 - c.y0 },
    members: [...c.members].sort((a, b) => a - b),
  }));
}

export function clipBox(box: PixelBox, width: number, height: number): PixelBox | null {
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(width, box.x + box.width);
  const y1 = Math.min(height, box.y + box.height);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}
