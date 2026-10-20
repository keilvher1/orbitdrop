import { describe, expect, it } from 'vitest';
import { HELPER_PROTOCOL_VERSION, parseHelperLine, type HelperToMainMessage } from '@orbitdrop/contracts';
import { DragSessionTracker } from '../src';

const v = HELPER_PROTOCOL_VERSION;
const state = (sessionId: string, s: 'PotentialDrag' | 'AwaitingPayload' | 'WheelActive' | 'Idle'): HelperToMainMessage => ({
  v,
  type: 'state',
  sessionId,
  state: s,
});
const drop = (sessionId: string, files = ['/Users/me/a.pdf']): HelperToMainMessage => ({
  v,
  type: 'drop',
  sessionId,
  actionId: 'convert.jpeg',
  mode: 'convert',
  files,
  dropEffect: 'copy',
});
const cancelled = (sessionId: string): HelperToMainMessage => ({ v, type: 'cancelled', sessionId, reason: 'escape' });

describe('DragSessionTracker', () => {
  it('follows a session through its states and accepts exactly one drop', () => {
    const t = new DragSessionTracker();
    expect(t.handle(state('s1', 'PotentialDrag'))).toEqual({ kind: 'stateChanged', sessionId: 's1', state: 'PotentialDrag' });
    expect(t.handle(state('s1', 'AwaitingPayload'))).toMatchObject({ state: 'AwaitingPayload' });
    expect(t.handle(state('s1', 'WheelActive'))).toMatchObject({ state: 'WheelActive' });
    const first = t.handle(drop('s1'));
    expect(first).toMatchObject({ kind: 'acceptDrop', drop: { sessionId: 's1', actionId: 'convert.jpeg' } });
    expect(t.stateOf('s1')).toBe('DropCommitted');
    expect(t.handle(drop('s1'))).toEqual({ kind: 'ignore', reason: 'duplicateDrop' });
    expect(t.handle(drop('s1', ['/other.pdf']))).toEqual({ kind: 'ignore', reason: 'duplicateDrop' });
  });

  it('accepts a drop for a session it never heard of (state messages are optional)', () => {
    const t = new DragSessionTracker();
    expect(t.handle(drop('fresh')).kind).toBe('acceptDrop');
  });

  it('ignores everything after DropCommitted', () => {
    const t = new DragSessionTracker();
    t.handle(drop('s1'));
    expect(t.handle(state('s1', 'WheelActive'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
    expect(t.handle(state('s1', 'Idle'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
    expect(t.handle(cancelled('s1'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
    expect(t.stateOf('s1')).toBe('DropCommitted');
  });

  it('refuses a drop after cancel, and reports a repeated cancel only once', () => {
    const t = new DragSessionTracker();
    t.handle(state('s1', 'WheelActive'));
    expect(t.handle(cancelled('s1'))).toEqual({ kind: 'stateChanged', sessionId: 's1', state: 'Cancelled' });
    expect(t.handle(cancelled('s1'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
    expect(t.handle(drop('s1'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
    expect(t.handle(state('s1', 'WheelActive'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
  });

  it('treats a helper-reported Idle as the end of the session', () => {
    const t = new DragSessionTracker();
    t.handle(state('s1', 'PotentialDrag'));
    expect(t.handle(state('s1', 'Idle'))).toEqual({ kind: 'stateChanged', sessionId: 's1', state: 'Idle' });
    expect(t.handle(drop('s1'))).toEqual({ kind: 'ignore', reason: 'sessionClosed' });
  });

  it('closes open sessions of a restarted helper and ignores their late messages', () => {
    const t = new DragSessionTracker();
    t.handle(state('old', 'WheelActive'));
    t.handle(drop('done'));
    expect(t.currentGeneration).toBe(0);
    expect(t.helperRestarted()).toBe(1);
    expect(t.stateOf('old')).toBe('Cancelled');
    expect(t.stateOf('done')).toBe('DropCommitted');
    expect(t.handle(drop('old'))).toEqual({ kind: 'ignore', reason: 'staleGeneration' });
    expect(t.handle(state('old', 'WheelActive'))).toEqual({ kind: 'ignore', reason: 'staleGeneration' });
    expect(t.handle(cancelled('old'))).toEqual({ kind: 'ignore', reason: 'staleGeneration' });
    // New sessions of the new helper work normally.
    expect(t.handle(drop('new')).kind).toBe('acceptDrop');
  });

  it('uses the generation main tags messages with', () => {
    const t = new DragSessionTracker();
    const g0 = t.currentGeneration;
    const g1 = t.helperRestarted();
    // A late line from the old process with a brand-new session id.
    expect(t.handle(drop('never-seen'), g0)).toEqual({ kind: 'ignore', reason: 'staleGeneration' });
    expect(t.stateOf('never-seen')).toBeUndefined();
    expect(t.handle(drop('never-seen'), g1).kind).toBe('acceptDrop');
  });

  it('lets a restarted helper reuse a session id when messages are tagged with the new generation', () => {
    const t = new DragSessionTracker();
    t.handle(state('s1', 'WheelActive'));
    t.handle(drop('s2'));
    const g = t.helperRestarted();
    expect(t.handle(state('s1', 'PotentialDrag'))).toEqual({ kind: 'ignore', reason: 'staleGeneration' });
    expect(t.handle(state('s1', 'PotentialDrag'), g)).toEqual({ kind: 'stateChanged', sessionId: 's1', state: 'PotentialDrag' });
    expect(t.handle(drop('s1'), g).kind).toBe('acceptDrop');
    expect(t.handle(drop('s2'), g).kind).toBe('acceptDrop');
    expect(t.handle(drop('s2'), g)).toEqual({ kind: 'ignore', reason: 'duplicateDrop' });
  });

  it('ignores non-session messages', () => {
    const t = new DragSessionTracker();
    const pong = parseHelperLine(JSON.stringify({ v, type: 'pong', nonce: 1 }))!;
    expect(t.handle(pong)).toEqual({ kind: 'ignore', reason: 'notSessionMessage' });
    const ready = parseHelperLine(
      JSON.stringify({ v, type: 'ready', helperVersion: '1.0', platform: 'darwin', arch: 'arm64', osVersion: '26.6', pid: 42, globalDrag: { available: true } }),
    )!;
    expect(t.handle(ready)).toEqual({ kind: 'ignore', reason: 'notSessionMessage' });
    expect(t.size).toBe(0);
  });

  it('evicts the least recently touched sessions, never the one just touched (even if the clock goes back)', () => {
    let now = 10_000;
    const t = new DragSessionTracker(3, () => (now -= 100)); // clock runs backwards
    t.handle(drop('a'));
    t.handle(state('b', 'WheelActive'));
    t.handle(state('c', 'WheelActive'));
    t.handle(state('a', 'Idle')); // touching a makes b the least recently used
    t.handle(state('d', 'WheelActive'));
    expect(t.size).toBe(3);
    expect(t.stateOf('b')).toBeUndefined();
    expect(t.stateOf('a')).toBe('DropCommitted');
    expect(t.stateOf('d')).toBe('WheelActive');
    // The newest session survives a full table: its duplicate drop is still detected.
    t.handle(drop('e'));
    expect(t.handle(drop('e'))).toEqual({ kind: 'ignore', reason: 'duplicateDrop' });
    const tiny = new DragSessionTracker(0);
    tiny.handle(drop('x'));
    expect(tiny.handle(drop('x'))).toEqual({ kind: 'ignore', reason: 'duplicateDrop' });
  });
});
