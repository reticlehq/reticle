/**
 * The agent's MCP server announces the agent's own session id on its connect, so the daemon can
 * join a connection's episode to the agent hooks' `agent-<session>.jsonl` without guessing.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_PARAM, agentSessionQuery, agentSessionOf } from './peer-announce.js';

describe('the agent session on the MCP connect', () => {
  it("announces Claude Code's session id, and nothing when there is none", () => {
    expect(agentSessionQuery({ CLAUDE_CODE_SESSION_ID: 'c588f971-x' })).toBe(
      `&${AGENT_SESSION_PARAM}=c588f971-x`,
    );
    expect(agentSessionQuery({})).toBe('');
  });

  it('reads it back only as a plain id', () => {
    expect(agentSessionOf('c588f971-27c3-48cb')).toBe('c588f971-27c3-48cb');
    expect(agentSessionOf(null)).toBeUndefined();
    expect(agentSessionOf('../../etc')).toBeUndefined();
    expect(agentSessionOf('x'.repeat(300))).toBeUndefined();
  });
});
