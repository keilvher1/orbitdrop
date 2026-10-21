/**
 * Orders editor preview responses. Every request gets a monotonically
 * increasing `seq` (sent to main, which may answer `stale` for superseded
 * requests). A response is applied only if it is newer than everything applied
 * so far, so a slow old preview can never overwrite a newer one, while an
 * older-but-unseen response still improves on what is on screen.
 */
export class PreviewSequencer {
  private requested = 0;
  private applied = 0;

  /** Seq for a new request (starts at 1). */
  next(): number {
    this.requested += 1;
    return this.requested;
  }

  /** True if a response with this seq should be applied; records it as applied. */
  accept(seq: number): boolean {
    if (!Number.isInteger(seq) || seq <= this.applied || seq > this.requested) return false;
    this.applied = seq;
    return true;
  }

  /**
   * Treat every outstanding request as stale (e.g. the options were cleared):
   * their responses will be rejected by `accept`. Later requests work normally.
   */
  invalidate(): void {
    this.applied = this.requested;
  }

  /** A newer request than the last applied response is still outstanding. */
  get pending(): boolean {
    return this.applied < this.requested;
  }

  get latestRequested(): number {
    return this.requested;
  }

  get latestApplied(): number {
    return this.applied;
  }
}
