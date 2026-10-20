import type { HelperDropMessage, HelperToMainMessage } from '@orbitdrop/contracts';

/**
 * Main-side view of the helper's drag sessions.
 *
 *   Idle → PotentialDrag → AwaitingPayload → WheelActive → DropCommitted → (Editing | Processing) → …
 *
 * The helper owns everything up to the drop. Main uses this tracker to accept
 * a drop exactly once per sessionId and to ignore duplicate, late or
 * out-of-order messages (e.g. a drop arriving after the session was cancelled,
 * or messages from a helper instance that was restarted).
 */

export type MainSessionState = 'PotentialDrag' | 'AwaitingPayload' | 'WheelActive' | 'DropCommitted' | 'Cancelled' | 'Idle';

export type TrackerDecision =
  | { readonly kind: 'acceptDrop'; readonly drop: HelperDropMessage }
  | { readonly kind: 'ignore'; readonly reason: 'duplicateDrop' | 'sessionClosed' | 'staleGeneration' | 'notSessionMessage' }
  | { readonly kind: 'stateChanged'; readonly sessionId: string; readonly state: MainSessionState };

interface SessionRecord {
  state: MainSessionState;
  generation: number;
  updatedAt: number;
}

export class DragSessionTracker {
  private readonly sessions = new Map<string, SessionRecord>();
  private generation = 0;

  constructor(
    private readonly maxSessions = 256,
    private readonly now: () => number = Date.now,
  ) {}

  /** Call when a (new) helper process reports ready: sessions of the old process are closed. */
  helperRestarted(): void {
    this.generation += 1;
    for (const record of this.sessions.values()) {
      if (record.state !== 'DropCommitted') record.state = 'Cancelled';
    }
  }

  stateOf(sessionId: string): MainSessionState | undefined {
    return this.sessions.get(sessionId)?.state;
  }

  handle(message: HelperToMainMessage): TrackerDecision {
    switch (message.type) {
      case 'state': {
        const record = this.touch(message.sessionId);
        if (record.generation !== this.generation) return { kind: 'ignore', reason: 'staleGeneration' };
        if (record.state === 'DropCommitted' || record.state === 'Cancelled') return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = message.state;
        return { kind: 'stateChanged', sessionId: message.sessionId, state: record.state };
      }
      case 'cancelled': {
        const record = this.touch(message.sessionId);
        if (record.state === 'DropCommitted') return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = 'Cancelled';
        return { kind: 'stateChanged', sessionId: message.sessionId, state: 'Cancelled' };
      }
      case 'drop': {
        const record = this.touch(message.sessionId);
        if (record.generation !== this.generation) return { kind: 'ignore', reason: 'staleGeneration' };
        if (record.state === 'DropCommitted') return { kind: 'ignore', reason: 'duplicateDrop' };
        if (record.state === 'Cancelled') return { kind: 'ignore', reason: 'sessionClosed' };
        record.state = 'DropCommitted';
        return { kind: 'acceptDrop', drop: message };
      }
      default:
        return { kind: 'ignore', reason: 'notSessionMessage' };
    }
  }

  private touch(sessionId: string): SessionRecord {
    let record = this.sessions.get(sessionId);
    if (!record) {
      record = { state: 'Idle', generation: this.generation, updatedAt: this.now() };
      this.sessions.set(sessionId, record);
      this.evict();
    }
    record.updatedAt = this.now();
    return record;
  }

  private evict(): void {
    if (this.sessions.size <= this.maxSessions) return;
    const oldest = [...this.sessions.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (const [id] of oldest.slice(0, this.sessions.size - this.maxSessions)) this.sessions.delete(id);
  }
}
