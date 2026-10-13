import { beforeEach, describe, expect, it } from 'vitest';
import {
  type NoticeFold,
  feedbackAlreadyAsked,
  firstSentenceOf,
  foldNotices,
  noteFeedbackAsked,
  resetNotices,
} from './notices.js';

const THROTTLED = 'this tab is throttled: a long paragraph about why';
const SKEW = 'version skew: a long paragraph about dispatched';
const FOLD: NoticeFold = {
  advisories: ['feedback_prompt', 'platform', 'session_lease'],
  notices: 'notices',
  next: 'next',
  warning: 'warning',
  onceWarnings: new Map<string, string | undefined>([
    [THROTTLED, undefined],
    [SKEW, 'version skew (short)'],
  ]),
};

beforeEach(() => resetNotices());

describe('notices: each advisory once per agent session', () => {
  it('folds advisory keys into one notices list and says each once', () => {
    const first = foldNotices(
      {
        verified: 'yes',
        feedback_prompt: { ask: 'How did it go?', command: 'reticle feedback' },
        platform: 'Tell the user, once: connect.',
      },
      'agent-1',
      FOLD,
    );
    expect(first).toEqual({
      verified: 'yes',
      notices: ['How did it go? (reticle feedback)', 'Tell the user, once: connect.'],
    });
    const second = foldNotices(
      { verified: 'yes', platform: 'Tell the user, once: connect.' },
      'agent-1',
      FOLD,
    );
    expect(second).toEqual({ verified: 'yes' });
  });

  it('a different agent session hears it again', () => {
    foldNotices({ platform: 'p' }, 'agent-1', FOLD);
    expect(foldNotices({ platform: 'p' }, 'agent-2', FOLD)['notices']).toEqual(['p']);
  });

  it('`next` is said only when it is new', () => {
    expect(foldNotices({ next: 'yield' }, 'a', FOLD)['next']).toBe('yield');
    expect(foldNotices({ next: 'yield' }, 'a', FOLD)['next']).toBeUndefined();
    expect(foldNotices({ next: 'declare' }, 'a', FOLD)['next']).toBe('declare');
  });

  it('the throttled paragraph goes after the first time; the session flag never does', () => {
    const r = { session: { throttled: true }, warning: THROTTLED };
    expect(foldNotices(r, 'a', FOLD)['warning']).toBe(THROTTLED);
    const again = foldNotices(r, 'a', FOLD);
    expect(again['warning']).toBeUndefined();
    expect(again['session']).toEqual({ throttled: true });
  });

  it('the skew paragraph shrinks to one line, never disappears', () => {
    expect(foldNotices({ warning: SKEW }, 'a', FOLD)['warning']).toBe(SKEW);
    expect(foldNotices({ warning: SKEW }, 'a', FOLD)['warning']).toBe('version skew (short)');
  });

  it('a warning that is a per-call fact is never deduplicated', () => {
    foldNotices({ warning: 'real-input-fell-back' }, 'a', FOLD);
    expect(foldNotices({ warning: 'real-input-fell-back' }, 'a', FOLD)['warning']).toBe(
      'real-input-fell-back',
    );
  });

  it('an empty session list keeps one sentence and its executable next action', () => {
    const out = foldNotices(
      {
        sessions: [],
        why: 'No tab is connected. The dev server is not running on 5173, and more paragraphs.',
        next_action: { action: 'start_dev_server', command: 'pnpm dev', reason: 'r' },
      },
      'a',
      FOLD,
    );
    expect(out['why']).toBe('No tab is connected.');
    expect(out['next_action']).toEqual({
      action: 'start_dev_server',
      command: 'pnpm dev',
      reason: 'r',
    });
  });

  it('never touches a verdict key', () => {
    const r = { verified: 'no', because: 'b', verdict: { pass: false }, contradictions: [1] };
    expect(foldNotices(r, 'a', FOLD)).toEqual(r);
  });

  it('first sentence ignores a full stop inside a token', () => {
    expect(firstSentenceOf('Open app.tsx first. Then run it.')).toBe('Open app.tsx first.');
  });
});

describe('the feedback reflex is asked at most once per session', () => {
  it('records and answers per session', () => {
    expect(feedbackAlreadyAsked('a')).toBe(false);
    noteFeedbackAsked('a');
    expect(feedbackAlreadyAsked('a')).toBe(true);
    expect(feedbackAlreadyAsked('b')).toBe(false);
    expect(feedbackAlreadyAsked(undefined)).toBe(false);
  });
});

describe('a lease reminder object becomes its sentence, not a JSON blob', () => {
  it('reads the IMPORTANT field', () => {
    const fold = { ...FOLD, advisories: ['session_lease'] };
    const out = foldNotices(
      { session_lease: { sessionId: 's', opened_at: 1, IMPORTANT: 'Yield when you stop.' } },
      'lease',
      fold,
    );
    expect(out['notices']).toEqual(['Yield when you stop.']);
  });
});
