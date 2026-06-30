import { describe, expect, it } from 'vitest';
import { PresenterTone, SessionState } from '@reticle/protocol';
import { buildPresenterArgs } from './presenter-args.js';

describe('buildPresenterArgs', () => {
  it('omits text and tone for a live (non-ended) state', () => {
    expect(buildPresenterArgs(SessionState.ACTIVE, undefined, undefined)).toEqual({
      state: 'active',
    });
  });

  it('carries text but no tone for a calm, human-driven end (done)', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'all green', PresenterTone.CALM)).toEqual({
      state: 'ended',
      text: 'all green',
    });
  });

  it('rides a warn tone when the agent crashed/disconnected', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'Agent stopped', PresenterTone.WARN)).toEqual({
      state: 'ended',
      text: 'Agent stopped',
      tone: PresenterTone.WARN,
    });
  });

  it('rides a waiting tone when the agent handed back its turn', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'your turn', PresenterTone.WAITING)).toEqual({
      state: 'ended',
      text: 'your turn',
      tone: PresenterTone.WAITING,
    });
  });

  it('rides an ask tone when the agent is blocked on the human', () => {
    expect(buildPresenterArgs(SessionState.ENDED, 'Use Stripe?', PresenterTone.ASK)).toEqual({
      state: 'ended',
      text: 'Use Stripe?',
      tone: PresenterTone.ASK,
    });
  });

  it('a tone never rides a live state — only an ended one carries it', () => {
    expect(buildPresenterArgs(SessionState.ACTIVE, undefined, PresenterTone.WARN)).toEqual({
      state: 'active',
    });
  });
});
