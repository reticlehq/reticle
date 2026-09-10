/**
 * A ref means nothing outside the tab it came from, and this is the rule that refuses to guess.
 *
 * Reported from the field (#277): three tabs of one project connected, a snapshot taken against a
 * named session, and the act that followed omitted `sessionId`. Auto-selection picked a different
 * tab, the ref legitimately did not exist there, and the refusal read "that ref is stale: refs are
 * invalidated whenever the DOM re-renders" — confidently wrong, and it accuses the app under test.
 *
 * The quiet outcome is the worse one. Refs are minted from a per-document block, so tab B's `e7` is
 * a real, live, DIFFERENT element: the same call on a luckier day drives the wrong tab and returns a
 * green about a page nobody asked about.
 *
 * The surface already promises "refuses rather than guesses when ambiguous". So both directions are
 * pinned here, because a refusal that fires when one tab is clearly preferred is the cost the current
 * wording was rewritten to avoid.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  forgetRefProvenance,
  noteRefsMinted,
  refsLastMintedIn,
  wrongTabRefusal,
} from './ref-provenance.js';

const connected = [
  { sessionId: 'sA', url: 'http://localhost:3000/' },
  { sessionId: 'sB', url: 'http://localhost:3000/settings' },
];

beforeEach(forgetRefProvenance);

describe('the tab a ref came out of', () => {
  it('is remembered from the call that handed it out', () => {
    noteRefsMinted('sA');
    expect(refsLastMintedIn()).toBe('sA');
  });
});

describe('a ref from another tab is refused, by name', () => {
  it('refuses when the ref was minted in a session other than the one resolution picked', () => {
    noteRefsMinted('sA');
    const refusal = wrongTabRefusal({
      ref: 'e120005',
      explicitSessionId: undefined,
      chosenSessionId: 'sB',
      connected: () => connected,
    });
    expect(refusal).toBeDefined();
    // Names both tabs and the argument that settles it — the whole point is that the agent can act
    // on the message without a round trip to reticle_sessions.
    expect(refusal).toContain('sA');
    expect(refusal).toContain('sB');
    expect(refusal).toContain('sessionId');
    // and never the sentence that sent the reporter looking at their own app
    expect(refusal).not.toMatch(/stale/i);
  });

  it('lists the candidates, so the agent can pick without another call', () => {
    noteRefsMinted('sA');
    const refusal = wrongTabRefusal({
      ref: 'e1',
      explicitSessionId: undefined,
      chosenSessionId: 'sB',
      connected: () => connected,
    });
    expect(refusal).toContain('http://localhost:3000/settings');
  });
});

describe('what it must NOT do — the cost the surface wording was rewritten to avoid', () => {
  it('stays silent when resolution picked the tab the ref came from', () => {
    noteRefsMinted('sA');
    expect(
      wrongTabRefusal({
        ref: 'e1',
        explicitSessionId: undefined,
        chosenSessionId: 'sA',
        connected: () => connected,
      }),
    ).toBeUndefined();
  });

  it('stays silent when the caller named a session — they said which tab they meant', () => {
    noteRefsMinted('sA');
    expect(
      wrongTabRefusal({
        ref: 'e1',
        explicitSessionId: 'sB',
        chosenSessionId: 'sB',
        connected: () => connected,
      }),
    ).toBeUndefined();
  });

  it('stays silent for a call that carries no ref at all', () => {
    noteRefsMinted('sA');
    expect(
      wrongTabRefusal({
        ref: undefined,
        explicitSessionId: undefined,
        chosenSessionId: 'sB',
        connected: () => connected,
      }),
    ).toBeUndefined();
  });

  it('stays silent when nothing has minted a ref yet', () => {
    expect(
      wrongTabRefusal({
        ref: 'e1',
        explicitSessionId: undefined,
        chosenSessionId: 'sB',
        connected: () => connected,
      }),
    ).toBeUndefined();
  });

  it('stays silent when the minting tab is gone — that ref IS stale, and is already answered', () => {
    noteRefsMinted('sGone');
    expect(
      wrongTabRefusal({
        ref: 'e1',
        explicitSessionId: undefined,
        chosenSessionId: 'sB',
        connected: () => connected,
      }),
    ).toBeUndefined();
  });
});
