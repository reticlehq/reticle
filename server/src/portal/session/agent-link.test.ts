import { afterEach, describe, expect, it } from 'vitest';
import { forgetAgents, noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';
import { LiveControl } from './human/live-control.js';
import { agentLinkOf } from './agent-link.js';

afterEach(() => forgetAgents());

describe('what the HUD is told about its notes to the agent', () => {
  it('shows a note as sent until an agent call takes it, then as seen by that agent', async () => {
    noteAgentAttached('a1', 'claude-code');
    noteAgentAttached('a2', 'cursor-vscode');
    const live = new LiveControl();
    live.push('check the empty cart', 1);
    expect(agentLinkOf(live.history())).toEqual({
      agents: ['Claude Code', 'Cursor'],
      notes: [{ text: 'check the empty cart', seen: false }],
    });
    await runAsAgent('a2', async () => {
      const { callingAgent } = await import('@/hooks/coding-agents.js');
      live.drain(callingAgent());
    });
    expect(agentLinkOf(live.history()).notes).toEqual([
      { text: 'check the empty cart', seen: true, by: 'Cursor' },
    ]);
  });

  it('never says seen for a note nobody drained', () => {
    const live = new LiveControl();
    live.push('a', 1);
    live.push('b', 2);
    expect(agentLinkOf(live.history()).notes.every((note) => !note.seen)).toBe(true);
    expect(agentLinkOf(live.history()).agents).toEqual([]);
  });
});
