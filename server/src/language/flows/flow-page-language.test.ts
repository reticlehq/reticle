import { describe, expect, it } from 'vitest';
import {
  AnchorKind,
  DriftReason,
  FLOW_FILE_VERSION,
  ReplayStatus,
  type FlowFile,
  type FlowReplayResult,
} from '@reticlehq/core';
import { applyPageLanguageHint } from './flow-start-path.js';

/**
 * A flow recorded in English replays on a page that shows Arabic (#2278).
 *
 * The text step finds no match, and the next action said to check the page or go back to the start
 * route. The cause is the page language, so the agent replayed again on the wrong advice.
 */

const NAVIGATE_ADVICE = 'inspect the step — navigate to the start route and replay';

const flow = (startLang?: string): FlowFile => ({
  version: FLOW_FILE_VERSION,
  name: 'checkout',
  createdAt: 1,
  steps: [
    { tool: 'reticle_act', anchor: { kind: AnchorKind.COMPONENT, role: 'button', name: 'Pay' } },
  ],
  startPath: '/cart',
  ...(startLang === undefined ? {} : { startLang }),
});

const drifted = (reasonKind: DriftReason = DriftReason.COMPONENT_NOT_FOUND): FlowReplayResult => ({
  name: 'checkout',
  status: ReplayStatus.DRIFT,
  steps: [
    {
      step: 1,
      tool: 'reticle_act',
      anchor: 'button "Pay"',
      ok: false,
      drift: {
        reasonKind,
        reason: 'no element matched {by:text,value:"Pay"}',
        anchor: 'button "Pay"',
        nearest: null,
      },
    },
  ],
  decision: {
    verdict: 'drift',
    summary: '"checkout" drifted at step 1.',
    whatChanged: 'no element matched {by:text,value:"Pay"}',
    nextAction: NAVIGATE_ADVICE,
  },
});

describe('applyPageLanguageHint', () => {
  it('names the language change and a locale-free anchor when the page language differs', () => {
    const result = drifted();
    applyPageLanguageHint(result, flow('en'), { lang: 'ar' });
    expect(result.decision?.whatChanged).toContain('"en"');
    expect(result.decision?.whatChanged).toContain('"ar"');
    expect(result.decision?.nextAction).toContain('test id');
    expect(result.decision?.nextAction).not.toBe(NAVIGATE_ADVICE);
  });

  it('also names it when a text check never held', () => {
    const result = drifted(DriftReason.SIGNAL_NOT_OBSERVED);
    applyPageLanguageHint(result, flow('en'), { lang: 'ar' });
    expect(result.decision?.whatChanged).toContain('"ar"');
  });

  it('treats a regional tag of the same language as the same language', () => {
    const result = drifted();
    applyPageLanguageHint(result, flow('en'), { lang: 'en-US' });
    expect(result.decision?.nextAction).toBe(NAVIGATE_ADVICE);
  });

  it('is silent for a flow recorded before startLang existed', () => {
    const result = drifted();
    applyPageLanguageHint(result, flow(), { lang: 'ar' });
    expect(result.decision?.nextAction).toBe(NAVIGATE_ADVICE);
  });

  it('is silent when the replayed page sets no language', () => {
    const result = drifted();
    applyPageLanguageHint(result, flow('en'), { lang: undefined });
    expect(result.decision?.nextAction).toBe(NAVIGATE_ADVICE);
  });

  it('is silent for a test id that went missing, which reads no copy', () => {
    const result = drifted(DriftReason.TESTID_NOT_FOUND);
    applyPageLanguageHint(result, flow('en'), { lang: 'ar' });
    expect(result.decision?.nextAction).toBe(NAVIGATE_ADVICE);
  });

  it('rewrites the reason of a replay that missed its first step', () => {
    const result: FlowReplayResult = {
      ...drifted(),
      status: ReplayStatus.UNVERIFIABLE,
      unverifiable: { reason: 'did not reach step 1, so nothing was proved.' },
    };
    applyPageLanguageHint(result, flow('en'), { lang: 'ar' });
    expect(result.unverifiable?.reason).toContain('the page language changed');
    expect(result.unverifiable?.reason).toContain('did not reach step 1');
  });

  it('leaves a passing replay alone', () => {
    const result: FlowReplayResult = { name: 'checkout', status: ReplayStatus.OK, steps: [] };
    applyPageLanguageHint(result, flow('en'), { lang: 'ar' });
    expect(result.decision).toBeUndefined();
  });
});
