/**
 * Ending a session says what it proved.
 *
 * `end` is the moment an agent declares the whole task complete, which is exactly when "and what did
 * NOT hold" is worth one more line. The fold is `gapSummary`, the same one `reticle_context` and
 * `reticle report` serve, so the three cannot describe one session three ways.
 */
import { describe, expect, it } from 'vitest';
import {
  DiscoveryInvite,
  JOURNAL_FILE_VERSION,
  ReticleTool,
  Verified,
  type JournalAction,
} from '@reticlehq/core';
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

function depsWith(actions: JournalAction[]): { deps: unknown; panel: () => string | undefined } {
  let shown: string | undefined;
  const session = {
    id: 's1',
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
    expect(result['gap']).toEqual(['1 of 2 claims held', '1 unknown']);
    expect(panel()).toBe('Checkout fixed\n1 of 2 claims held');
    // For the agent to pass on: the end of a task is when somebody has an opinion about it.
    expect(result['talk_to_us']).toBe(DiscoveryInvite.AGENT);
  });

  it('says plainly when the session claimed nothing', async () => {
    const { deps, panel } = depsWith([]);
    const result = (await endTool?.handler(deps as never, {})) as Record<string, unknown>;
    expect(result['gap']).toEqual(['no claims this session, so nothing was verified']);
    expect(panel()).toBe('no claims this session, so nothing was verified');
  });
});
