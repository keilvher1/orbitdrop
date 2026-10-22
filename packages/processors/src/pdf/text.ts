import type { PdfPage } from './engine';

/**
 * Plain-text layout from PDF.js text items. PDF.js returns text runs in content
 * stream order, which for almost all documents is reading order (columns are
 * written one after another). Runs are grouped into lines by baseline (the y
 * of the text matrix) and PDF.js' end-of-line markers; lines are grouped into
 * paragraphs by vertical gaps. No layout reconstruction (tables, columns side
 * by side) is attempted.
 */

export interface PositionedText {
  readonly str: string;
  /** Baseline origin in PDF user space (y grows upwards). */
  readonly x: number;
  readonly y: number;
  /** Advance width in user space. */
  readonly width: number;
  /** Font size in user space. */
  readonly size: number;
  readonly hasEOL: boolean;
}

export interface TextLine {
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly size: number;
}

interface RawItem {
  readonly str?: unknown;
  readonly transform?: unknown;
  readonly width?: unknown;
  readonly height?: unknown;
  readonly hasEOL?: unknown;
}

/** Convert PDF.js TextContent items (ignoring marked-content markers). */
export function toPositioned(items: readonly unknown[]): PositionedText[] {
  const out: PositionedText[] = [];
  for (const raw of items) {
    const item = raw as RawItem;
    if (typeof item.str !== 'string' || !Array.isArray(item.transform)) continue;
    const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0] = item.transform as number[];
    const size = Math.hypot(c, d) || Math.hypot(a, b) || (typeof item.height === 'number' ? item.height : 0) || 1;
    out.push({
      str: item.str,
      x: e,
      y: f,
      width: typeof item.width === 'number' ? item.width : 0,
      size,
      hasEOL: item.hasEOL === true,
    });
  }
  return out;
}

const WS_END = /\s$/u;
const WS_START = /^\s/u;

interface LineBuilder {
  text: string;
  x: number;
  y: number;
  endX: number;
  size: number;
}

/** Group runs into lines: a new line starts after an EOL marker or when the baseline moves. */
export function groupLines(items: readonly PositionedText[]): TextLine[] {
  const lines: TextLine[] = [];
  const push = (line: LineBuilder): void => {
    const text = line.text.replace(/\s+$/u, '');
    lines.push({ text, x: line.x, y: line.y, width: Math.max(0, line.endX - line.x), size: line.size });
  };

  let current: LineBuilder | null = null;
  let breakNext = false;
  for (const item of items) {
    if (item.str.length > 0) {
      let appended = false;
      if (current !== null) {
        const size = Math.max(current.size, item.size);
        const sameBaseline = Math.abs(item.y - current.y) <= size * 0.5;
        const gap = item.x - current.endX;
        if (!breakNext && sameBaseline && gap >= -size) {
          if (gap > size * 0.2 && !WS_END.test(current.text) && !WS_START.test(item.str)) current.text += ' ';
          current.text += item.str;
          current.endX = Math.max(current.endX, item.x + item.width);
          current.size = Math.max(current.size, item.size);
          appended = true;
        } else {
          push(current);
        }
      }
      if (!appended) current = { text: item.str, x: item.x, y: item.y, endX: item.x + item.width, size: item.size };
      breakNext = false;
    }
    if (item.hasEOL) breakNext = true;
  }
  if (current !== null) push(current);
  return lines.filter((l) => l.text.trim().length > 0);
}

/** True when the vertical move from `prev` to `next` looks like a paragraph break. */
function isParagraphGap(prev: TextLine, next: TextLine): boolean {
  const size = Math.max(prev.size, next.size);
  const drop = prev.y - next.y;
  return drop <= -size * 0.5 || drop > size * 1.8;
}

/** Page text for TXT: one output line per text line, a blank line between paragraphs. */
export function linesToText(lines: readonly TextLine[]): string {
  let out = '';
  lines.forEach((line, i) => {
    if (i > 0) out += isParagraphGap(lines[i - 1]!, line) ? '\n\n' : '\n';
    out += line.text;
  });
  return out;
}

const CJK_NO_SPACE = /[぀-ヿ㐀-䶿一-鿿豈-﫿　-〿＀-￯]/u;

function joinLines(prev: string, next: string): string {
  const last = prev.slice(-1);
  const first = next.slice(0, 1);
  if (CJK_NO_SPACE.test(last) && CJK_NO_SPACE.test(first)) return prev + next;
  if (last === '-' && /\p{Ll}/u.test(first)) return prev + next;
  return `${prev} ${next}`;
}

/**
 * Paragraphs for DOCX: consecutive lines are merged (re-flowable text) when the
 * previous line is "full" (≥ 60 % of the text column, so it most likely
 * wrapped), the spacing is a normal line gap, the font size matches and the
 * left edge is close. Short lines (headings, list items, addresses) end their
 * paragraph. `columnWidth` is the page's estimated text column (page width
 * minus the left margin on both sides); without it the longest line is used.
 * Wrong merges are worse than missing ones, so the rules are conservative.
 */
export function linesToParagraphs(lines: readonly TextLine[], columnWidth = 0): string[] {
  if (lines.length === 0) return [];
  // A loop, not Math.max(...spread): a page with ~120k+ text lines overflows the call stack.
  let reference = columnWidth;
  for (const line of lines) reference = Math.max(reference, line.width);
  const paragraphs: string[] = [];
  let text = lines[0]!.text;
  let startX = lines[0]!.x;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = lines[i - 1]!;
    const line = lines[i]!;
    const size = Math.max(prev.size, line.size);
    const drop = prev.y - line.y;
    const merge =
      drop > 0 &&
      drop <= size * 1.6 &&
      Math.abs(prev.size - line.size) <= size * 0.2 &&
      prev.width >= reference * 0.6 &&
      Math.abs(line.x - startX) <= size * 3;
    if (merge) {
      text = joinLines(text, line.text.trimStart());
    } else {
      paragraphs.push(text);
      text = line.text;
      startX = line.x;
    }
  }
  paragraphs.push(text);
  return paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
}

export interface PageText {
  /** Text lines in reading order (empty for pages without extractable text). */
  readonly lines: TextLine[];
  /** Estimated width of the text column in user space (page width minus the left margin twice). */
  readonly columnWidth: number;
}

/** Text lines of one page in reading order, plus the page's text column estimate. */
export async function extractPageText(page: PdfPage): Promise<PageText> {
  const content = await page.getTextContent({ includeMarkedContent: false });
  const lines = groupLines(toPositioned(content.items));
  const [x0 = 0, , x1 = 0] = page.view;
  const left = Math.min(x0, x1);
  const pageWidth = Math.abs(x1 - x0);
  let minX = lines.length > 0 ? Infinity : left;
  for (const line of lines) minX = Math.min(minX, line.x);
  const margin = Math.min(Math.max(0, minX - left), pageWidth / 2);
  return { lines, columnWidth: Math.max(0, pageWidth - 2 * margin) };
}
