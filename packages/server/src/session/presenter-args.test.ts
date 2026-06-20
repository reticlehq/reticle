import { describe, expect, it } from 'vitest';
import { PresenterTone, SessionState } from '@syrin/iris-protocol';
import { buildPresenterArgs } from './presenter-args.js';

describe('buildPresenterArgs', () => {
  it('omits text and tone for a live (non-ended) state', () => {
    expect(buildPresenterArgs(SessionState.ACTIVE, undefined, false)).toEqual({ state: 'active' });
  });

  it('carries text but no tone for a human-driven (non-auto) end', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'all green', false)).toEqual({
      state: 'ended',
      text: 'all green',
    });
  });

  it('rides a warn tone when the session auto-ended (agent stopped / idle)', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'Agent stopped', true)).toEqual({
      state: 'ended',
      text: 'Agent stopped',
      tone: PresenterTone.WARN,
    });
  });

  it('warn tone only applies to an ended state — an auto flag on a live state is ignored', () => {
    expect(buildPresenterArgs(SessionState.ACTIVE, undefined, true)).toEqual({ state: 'active' });
  });
});
