import { describe, expect, it } from 'vitest';
import { AnchorKind, DriftReason, ReplayStatus, type FlowFile } from '@reticlehq/core';
import { buildDecision } from './decision.js';

/**
 * A step whose anchor was fine, reported as a locator that moved.
 *
 * MEASURED against the bench app. A flow clicked `login-submit` and expected `nav-deployments`
 * afterwards. The click landed; the dashboard did not appear. Replay answered:
 *
 *   whatChanged   expect.element testid "nav-deployments" not present after the action
 *   whereInSource src/components/Login.tsx:81
 *   nextAction    rebind the anchor to "login-submit" (closest survivor), or update the flow …
 *
 * Three things wrong at once, all from one cause. The source pointer names the file of the element
 * that was CLICKED, sending the reader to a component nobody touched. The suggestion is to rebind
 * the anchor, which resolved perfectly. And the value it proposes is the anchor's own current
 * value, so following the advice literally rebinds `login-submit` to `login-submit`.
 *
 * `DriftReason.EXPECT_ELEMENT_NOT_FOUND` already exists to separate these, and its own comment in
 * flow-constants.ts says reporting one as the other "sends the caller looking for a renamed anchor
 * on a step whose anchor was fine". The replay layer set it correctly; the decision layer read
 * every drift as an anchor drift.
 */
const flow = {
  version: 1,
  name: 'sign-in',
  steps: [
    {
      tool: 'reticle_act',
      anchor: {
        kind: AnchorKind.TESTID,
        value: 'login-submit',
        source: { file: 'src/components/Login.tsx', line: 81, column: 8 },
      },
      action: 'click',
      expect: { element: { testid: 'nav-deployments' } },
    },
  ],
} as unknown as FlowFile;

const expectDrift = (nearest: string | null) =>
  buildDecision(
    {
      name: 'sign-in',
      status: ReplayStatus.DRIFT,
      steps: [
        {
          step: 0,
          anchor: 'login-submit',
          ok: false,
          drift: {
            reasonKind: DriftReason.EXPECT_ELEMENT_NOT_FOUND,
            reason: 'expect.element testid "nav-deployments" not present after the action',
            anchor: 'nav-deployments',
            nearest,
          },
        },
      ],
    },
    flow,
  );

describe('a consequence that never appeared is not a locator that moved', () => {
  it('does not send the reader to the file of the element that was acted on', () => {
    // Login.tsx is where the CLICK lives. The thing that is missing lives somewhere else entirely,
    // and no source was ever recorded for it — so the honest answer is to say nothing.
    expect(expectDrift('login-submit').whereInSource).toBeUndefined();
  });

  it('never tells the reader to rebind the anchor that resolved', () => {
    const d = expectDrift('login-submit');
    expect(d.nextAction).not.toMatch(/rebind the anchor/);
    expect(d.suggestedFix).toBeUndefined();
  });

  it('points at the handler behind the action rather than the locator', () => {
    expect(expectDrift('login-submit').nextAction).toMatch(/handler|never appeared|consequence/i);
  });

  it('still reports WHAT was missing', () => {
    expect(expectDrift('login-submit').whatChanged).toContain('nav-deployments');
  });

  it('offers a rename only when the survivor is not the anchor itself', () => {
    // A genuinely renamed consequence is worth proposing — aimed at the step's `expect`, never at
    // the anchor, because the anchor is not what failed.
    const d = expectDrift('nav-item-deployments');
    expect(d.suggestedFix).toContain('nav-item-deployments');
    expect(d.suggestedFix).toMatch(/expect/i);
    expect(d.suggestedFix).not.toMatch(/rebind the anchor/);
  });

  it('leaves a real ANCHOR drift reporting exactly as before', () => {
    const anchorDrift = buildDecision(
      {
        name: 'sign-in',
        status: ReplayStatus.DRIFT,
        steps: [
          {
            step: 0,
            anchor: 'login-submit',
            ok: false,
            drift: {
              reasonKind: DriftReason.TESTID_NOT_FOUND,
              reason: 'testid "login-submit" not found',
              anchor: 'login-submit',
              nearest: 'login-send',
            },
          },
        ],
      },
      flow,
    );
    expect(anchorDrift.whereInSource).toBe('src/components/Login.tsx:81');
    expect(anchorDrift.nextAction).toContain('rebind the anchor to "login-send"');
  });
});
