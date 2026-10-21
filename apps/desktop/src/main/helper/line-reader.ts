/**
 * Splits a byte stream into '\n'-terminated UTF-8 lines with a hard length
 * limit. A line longer than `maxLineBytes` is dropped entirely (everything up
 * to its newline), so a misbehaving helper cannot make main buffer unbounded
 * data. Lines are decoded only once complete, so multi-byte characters split
 * across chunks are handled. A trailing '\r' is removed; empty lines skipped.
 */
export class LineReader {
  private chunks: Buffer[] = [];
  private size = 0;
  private discarding = false;

  constructor(
    private readonly maxLineBytes: number,
    private readonly onLine: (line: string) => void,
    private readonly onOverflow: () => void = () => undefined,
  ) {}

  push(chunk: Buffer | Uint8Array | string): void {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      if (newline === -1) {
        this.append(data.subarray(start));
        return;
      }
      const piece = data.subarray(start, newline);
      start = newline + 1;
      if (this.discarding) {
        this.discarding = false;
        continue;
      }
      if (this.size + piece.length > this.maxLineBytes) {
        this.reset();
        this.onOverflow();
        continue;
      }
      const line = this.size === 0 ? piece : Buffer.concat([...this.chunks, piece], this.size + piece.length);
      this.reset();
      let text = line.toString('utf8');
      if (text.endsWith('\r')) text = text.slice(0, -1);
      if (text.length > 0) this.onLine(text);
    }
  }

  /** Bytes buffered for an incomplete line. */
  get pendingBytes(): number {
    return this.size;
  }

  private append(rest: Buffer): void {
    if (this.discarding || rest.length === 0) return;
    if (this.size + rest.length > this.maxLineBytes) {
      this.reset();
      this.discarding = true;
      this.onOverflow();
      return;
    }
    this.chunks.push(rest);
    this.size += rest.length;
  }

  private reset(): void {
    this.chunks = [];
    this.size = 0;
  }
}
