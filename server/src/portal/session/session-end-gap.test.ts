/**
 * Ending a session says what it proved.
 *
 * `end` is the moment an agent declares the whole task complete, which is exactly when "and what did
 * NOT hold" is worth one more line. The fold is `gapSummary`, the same one `reticle_context` and
 * `reticle report` serve, so the three cannot describe one session three ways.
 */
import { describe, expect, it } from 'vitest';
import { JOURNAL_FILE_VERSION, ReticleTool, Verified, type JournalAction } from '@reticlehq/core';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';

const endTool = LIVE_CONTROL_TOOLS.find((t) => t.name === ReticleTool.END_SESSION);

const action = (verified: Verified, i: number): JournalAction => ({
  v: JOURNAL_FILE_VERSION,
  actionId: `c${String(i)}`,
  tool: 'reticle_act_and_wait',
  args: {},
  effect: { claim: `claim ${String(i)}`, verified },
  tRange: { from: 0, to: 1 },
  at: 0,
});

function depsWith(
  actions: JournalAction[],
  id = 's1',
): { deps: unknown; panel: () => string | undefined } {
  let shown: string | undefined;
  const session = {
    id,
    setState: (_state: string, text?: string) => {
      shown = text;
    },
    readJournalActions: () => Promise.resolve(actions),
  };
  return {
    deps: { sessions: { count: () => 1, resolve: () => session } },
    panel: () => shown,
  };
}

describe('reticle_session {action:"end"} reports the gap', () => {
  it('returns held of claimed, and puts the headline under the agent summary on the panel', async () => {
    const { deps, panel } = depsWith([action(Verified.YES, 0), action(Verified.UNKNOWN, 1)]);
    const result = (await endTool?.handler(deps as never, { summary: 'Checkout fixed' })) as Record<
      string,
      unknown
    >;
    expect(result['gap']).toEqual(['1 of 2 claims held', '1 unknown: claim 1']);
    expect(panel()).toBe('Checkout fixed\n1 of 2 claims held');
    // Not on an ordinary end: the founder's call is offered to someone stuck, never at every end.
    expect(result['talk_to_us']).toBeUndefined();
  });

  it('lists an unverifiable suite beside a passed act, and does not agree the session passed', async () => {
    const passed = action(Verified.YES, 0);
    const suite: JournalAction = {
      ...passed,
      actionId: 'suite',
      tool: ReticleTool.FLOW_REPLAY,
      effect: {
        claim: 'the flow "checkout" replays and its checks hold',
        verified: Verified.UNKNOWN,
      },
    };
    const { deps } = depsWith([passed, suite], 's-suite');
    const result = (await endTool?.handler(deps as never, { claim: 'pass' })) as Record<
      string,
      unknown
    >;
    expect(result['gap']).toEqual([
      '1 of 2 claims held',
      '1 unknown: the flow "checkout" replays and its checks hold',
    ]);
    expect(result['claim']).toEqual({ claimed: 'pass', graded: 'partial', agrees: false });
  });

  it('lists a failed suite beside a passed act, and does not agree the session passed', async () => {
    const passed = action(Verified.YES, 0);
    const suite: JournalAction = {
      ...passed,
      actionId: 'suite-fail',
      tool: ReticleTool.FLOW_REPLAY,
      effect: {
        claim: 'the flow "checkout" replays and its checks hold',
        verified: Verified.NO,
      },
    };
    const { deps } = depsWith([passed, suite], 's-fail');
    const result = (await endTool?.handler(deps as never, { claim: 'pass' })) as Record<
      string,
      unknown
    >;
    expect(result['gap']).toEqual([
      '1 of 2 claims held',
      '1 failed',
      '  ✗ the flow "checkout" replays and its checks hold',
    ]);
    expect(result['claim']).toEqual({ claimed: 'pass', graded: 'fail', agrees: false });
  });

  it('says plainly when the session claimed nothing', async () => {
    const { deps, panel } = depsWith([]);
    const result = (await endTool?.handler(deps as never, {})) as Record<string, unknown>;
    expect(result['gap']).toEqual(['no claims this session, so nothing was verified']);
    expect(panel()).toBe('no claims this session, so nothing was verified');
  });
});
