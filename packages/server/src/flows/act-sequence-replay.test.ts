/**
 * Every flow containing an act_sequence step drifted on replay, on 5 of 5 apps.
 *
 *   step 2: {"tool":"reticle_act_sequence","anchor":"unresolved","ok":false,
 *            "drift":{"reasonKind":"testid_not_found","reason":"testid \"unresolved\" not found"}}
 *
 * That is flow_replay = drift, flow_verify = fail, flow_heal = unhealable, everywhere. Three separate
 * defects stack to produce it, and fixing only the obvious one turns the drift into a different lie.
 *
 * 1. THE SEQUENCE TOOK subs[0].anchor UNCONDITIONALLY. A first sub-step without a testid is itself
 *    degraded, so the whole sequence inherited `DEGRADED_ANCHOR_ROLE` — the sentinel meaning "no
 *    anchor could be determined" — even when every later sub-step was perfectly anchored.
 *
 * 2. REPLAY QUERIED THE SENTINEL AS IF IT WERE A LOCATOR. A nameless ROLE anchor falls through to the
 *    testid runner, which asked the DOM eight times for a testid literally named "unresolved", found
 *    none (it never exists), and reported a MISSING ELEMENT. It then ran edit-distance against the
 *    word "unresolved" and offered `ErrorOutlineIcon` as the nearest match — which flow_verify printed
 *    as a rebind target while flow_heal refused it (confidence 0.13 < 0.5). Two tools contradicting
 *    each other over a candidate that never meant anything.
 *
 * 3. replayFlow HAS NO ACT_SEQUENCE BRANCH AT ALL. It dispatches on `anchor.kind`, so a saved
 *    sequence ran ONE act with `action: ''` and sub-steps 2..n never executed. `replayProgram` has the
 *    branch for in-memory recordings; the saved-flow path never got it. So fixing (1) and (2) alone
 *    would replace "drifted" with "silently ran one step of five and called it ok".
 */

import { describe, expect, it } from 'vitest';
import { AnchorKind, DEGRADED_ANCHOR_ROLE, DriftReason } from '@reticlehq/core';
import { ReticleTool } from '../tools/tool-names.js';
import { recordedStepToFlowStep } from './flows.js';
import { isDegradedAnchor } from './flow-step-runners.js';

describe('an act_sequence takes the first anchor it HAS', () => {
  it('skips a degraded first sub-step for one that is anchored', () => {
    const out = recordedStepToFlowStep({
      tool: ReticleTool.ACT_SEQUENCE,
      stable: false,
      args: {
        steps: [
          { ref: 'e9', action: 'click', args: {} },
          { by: 'testid', value: 'save-btn', action: 'click', args: {} },
        ],
      },
    });
    expect(out.anchor.kind).toBe(AnchorKind.TESTID);
    expect(isDegradedAnchor(out.anchor)).toBe(false);
  });

  it('still degrades when NO sub-step has an anchor — there is nothing to borrow', () => {
    const out = recordedStepToFlowStep({
      tool: ReticleTool.ACT_SEQUENCE,
      stable: false,
      args: { steps: [{ ref: 'e9', action: 'click', args: {} }] },
    });
    expect(isDegradedAnchor(out.anchor)).toBe(true);
  });
});

describe('the sentinel is a marker, never a locator', () => {
  it('is recognised', () => {
    expect(isDegradedAnchor({ kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE })).toBe(true);
  });

  it('a REAL role anchor is not mistaken for it', () => {
    // `role: 'unresolved'` with a name is a genuine (if odd) anchor; the sentinel never has a name.
    expect(
      isDegradedAnchor({ kind: AnchorKind.ROLE, role: DEGRADED_ANCHOR_ROLE, name: 'Save' }),
    ).toBe(false);
    expect(isDegradedAnchor({ kind: AnchorKind.ROLE, role: 'button', name: 'Save' })).toBe(false);
  });

  it('a testid anchor is not it', () => {
    expect(isDegradedAnchor({ kind: AnchorKind.TESTID, value: 'save-btn' })).toBe(false);
  });
});

describe('the drift a degraded step reports', () => {
  it('has its own reason kind, distinct from a missing element', () => {
    // "your element disappeared" and "this step never had an element bound to it" need different
    // fixes. Reporting the second as the first is what sent heal hunting for the nearest testid to
    // the word "unresolved".
    expect(DriftReason.ANCHOR_DEGRADED).toBeDefined();
    expect(DriftReason.ANCHOR_DEGRADED).not.toBe(DriftReason.TESTID_NOT_FOUND);
  });
});
