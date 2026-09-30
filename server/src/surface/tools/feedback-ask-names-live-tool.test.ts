/**
 * A message that tells the agent to report a problem must name a tool the agent can call.
 *
 * `FEEDBACK_ASK`, the crawl's empty-run note and the four friction invitations all said "call reticle_feedback" after that name
 * was retired into `reticle_session { action: "feedback" }`. The retired name only returns a
 * redirect, so an agent that followed the instruction spent a call learning the real name, at the
 * exact moment Reticle was asking it to report a Reticle defect.
 */

import { describe, expect, it } from 'vitest';
import { FEEDBACK_ASK } from './error-recovery.js';
import { retiredToolNames } from './merged-name-redirect.js';
import { crawlEmptyNote } from '@/features/crawl/crawl-empty.js';
import { FrictionKind, inviteFor } from './feedback-invite.js';

const retiredNamedIn = (text: string): string[] =>
  Object.keys(retiredToolNames()).filter((name) => new RegExp(`\\b${name}\\b`).test(text));

describe('feedback instructions name a live tool', () => {
  it('the unrecognised-error ask', () => {
    expect(retiredNamedIn(FEEDBACK_ASK)).toEqual([]);
    expect(FEEDBACK_ASK).toContain('reticle_session');
  });

  it('the crawl that found controls and clicked none', () => {
    const note =
      crawlEmptyNote({ interactiveFound: 34, stepsRun: 0, maxSteps: 25, truncated: false }) ?? '';
    expect(retiredNamedIn(note)).toEqual([]);
    expect(note).toContain('reticle_session');
  });

  it.each(Object.values(FrictionKind))('the %s feedback invitation', (kind) => {
    const invite = inviteFor(kind);
    expect(retiredNamedIn(invite)).toEqual([]);
    expect(invite).toContain('reticle_session');
  });
});
