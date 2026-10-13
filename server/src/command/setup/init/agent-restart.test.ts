import { describe, expect, it } from 'vitest';
import { attachedAgents, restartNotice } from './agent-restart.js';

/**
 * The restart gap: an agent whose session started before Reticle was registered has no
 * `reticle_*` tools, runs `init` through its shell, and is then told to call `reticle_act_and_wait`.
 * `init` said "restart" only when THIS run registered the server, so the commonest order (installer
 * in one terminal while the agent was already open, then the agent runs init) got no word at all.
 */
describe('init tells an agent without the tools to restart', () => {
  it('says so when it runs inside an agent and no agent is attached to the daemon', () => {
    const notice = restartNotice({ insideAgent: true, newlyRegistered: false, attached: 0 });
    expect(notice).toMatch(/^Restart your coding agent now/);
    expect(notice).toContain('--relaunch');
  });

  it('says so when this run registered the server, attached or not', () => {
    expect(
      restartNotice({ insideAgent: false, newlyRegistered: true, attached: undefined }),
    ).toMatch(/^Restart your coding agent now/);
  });

  it('stays quiet when an agent already has the tools', () => {
    expect(
      restartNotice({ insideAgent: true, newlyRegistered: false, attached: 1 }),
    ).toBeUndefined();
  });

  it('stays quiet for a person at a terminal, and when the daemon could not be asked', () => {
    expect(
      restartNotice({ insideAgent: false, newlyRegistered: false, attached: 0 }),
    ).toBeUndefined();
    expect(
      restartNotice({ insideAgent: true, newlyRegistered: false, attached: undefined }),
    ).toBeUndefined();
  });

  it('reads the attached agents off the daemon status, and nothing off anything else', () => {
    expect(attachedAgents({ running: true, mcpPeers: ['3.7.0', '3.7.0'] })).toBe(2);
    expect(attachedAgents({ running: true, sessions: [] })).toBe(0);
    expect(attachedAgents(undefined)).toBeUndefined();
  });
});
