import type { HelperDropMessage, HelperToMainMessage } from '@orbitdrop/contracts';

/**
 * Main-side view of the helper's drag sessions.
 *
 *   Idle → PotentialDrag → AwaitingPayload → WheelActive → DropCommitted → (Editing | Processing) → …
 *
 * The helper owns everything up to the drop. Main uses this tracker to accept
 * a drop exactly once per sessionId and to ignore duplicate, late or
 * out-of-order messages:
 *  - a second `drop` for a session                          → duplicateDrop
 *  - `drop` after `cancelled` or after the helper reported
 *    state `Idle` (the session ended without a drop)        → sessionClosed
 *  - `state` / `cancelled` after the session closed         → sessionClosed
 *  - messages from a previous helper process                → staleGeneration
 *    (sessions seen before `helperRestarted()`, or any message main tags with
 *    an older generation via `handle(message, generation)`). Untagged messages
 *    whose session id was seen before the restart are treated as stale, so
 *    helpers must not reuse session ids across processes unless main tags
 *    messages with the generation.
 * Post-drop states (Editing/Processing/…) are tracked by main's job/editor
 * code, not here.
 */

export type MainSessionState = 'PotentialDrag' | 'AwaitingPayload' | 'WheelActive' | 'DropCommitted' | 'Cancelled' | 'Idle';

export type TrackerDecision =
  | { readonly kind: 'acceptDrop'; readonly drop: HelperDropMessage }
  | { readonly kind: 'ignore'; readonly reason: 'duplicateDrop' | 'sessionClosed' | 'staleGeneration' | 'notSessionMessage' }
  | { readonly kind: 'stateChanged'; readonly sessionId: string; readonly state: MainSessionState };

interface SessionRecord {
  state: MainSessionState;
  /** True once the session can no longer produce a drop (DropCommitted, Cancelled, helper Idle). */
  closed: boolean;
  generation: number;
  updatedAt: number;
}

export class DragSessionTracker {
  /** Insertion order = least recently touched first (records are re-inserted on every touch). */
  private readonly sessions = new Map<string, SessionRecord>();
  private generation = 0;

  constructor(
    private readonly maxSessions = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** Generation of the current helper process (0 before the first restart). */
  get currentGeneration(): number {
    return this.generation;
  }

  /**
   * Call when a (new) helper process reports ready: open sessions of the old
   * process are cancelled. Returns the new generation; main may tag messages
   * of the new process with it (`handle(message, generation)`).
   */
  helperRestarted(): number {
    this.generation += 1;
    for (const record of this.sessions.values()) {
      if (!record.closed) {
        record.state = 'Cancelled';
        record.closed = true;
      }
    }
    return this.generation;
  }

  stateOf(sessionId: string): MainSessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  /** Number of remembered sessions (bounded by maxSessions). */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Decide what to do with a helper message. `generation` (optional) is the
   * generation of the helper process that produced the line; messages from an
   * older process are ignored even for session ids never seen before.
   */
  handle(message: HelperToMainMessage, generation?: number): TrackerDecision {
    if (message.type !== 'state' && message.type !== 'cancelled' && message.type !== 'drop') {
      return { kind: 'ignore', reason: 'notSessionMessage' };
    }
    if (generation !== undefined && generation !== this.generation) return { kind: 'ignore', reason: 'staleGeneration' };
    // A message tagged with the current generation proves it comes from the current process, so an
    // old record that happens to use the same session id (a restarted helper reusing ids) is replaced.
    const record = this.touch(message.sessionId, generation !== undefined);
    if (record.generation !== this.generation) return { kind: 'ignore', reason: 'staleGeneration' };

    switch (message.type) {
      case 'state': {
        if (record.closed) return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = message.state;
        if (message.state === 'Idle') record.closed = true;
        return { kind: 'stateChanged', sessionId: message.sessionId, state: record.state };
      }
      case 'cancelled': {
        if (record.closed) return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = 'Cancelled';
        record.closed = true;
        return { kind: 'stateChanged', sessionId: message.sessionId, state: 'Cancelled' };
      }
      case 'drop': {
        if (record.state === 'DropCommitted') return { kind: 'ignore', reason: 'duplicateDrop' };
        if (record.closed) return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = 'DropCommitted';
        record.closed = true;
        return { kind: 'acceptDrop', drop: message };
      }
    }
  }

  private touch(sessionId: string, renewStale: boolean): SessionRecord {
    let record = this.sessions.get(sessionId);
    if (record) this.sessions.delete(sessionId);
    if (!record || (renewStale && record.generation !== this.generation)) {
      record = { state: 'Idle', closed: false, generation: this.generation, updatedAt: this.now() };
    }
    record.updatedAt = this.now();
    this.sessions.set(sessionId, record);
    this.evict();
    return record;
  }

  /** Forget the least recently touched sessions beyond maxSessions (never the one just touched). */
  private evict(): void {
    const limit = Math.max(1, this.maxSessions);
    while (this.sessions.size > limit) {
      const oldest = this.sessions.keys().next();
      if (oldest.done) break;
      this.sessions.delete(oldest.value);
    }
  }
}
