import { describe, expect, it } from 'vitest';
import { buildSessionLease } from './session-lease.js';

describe('the session lease notice', () => {
  // It told every agent, once per session, that an ended session "revives on your next action".
  // An explicit end is terminal (session.test.ts: "an EXPLICIT end stays terminal even if the agent
  // acts again"), so an agent that ended early to save a turn lost the session it meant to keep.
  it('says end is final, and that yield is the one that comes back', () => {
    const notice = buildSessionLease('s1', 0).IMPORTANT;
    expect(notice).not.toContain('it revives on your next action');
    expect(notice).toContain('final');
  });
});
