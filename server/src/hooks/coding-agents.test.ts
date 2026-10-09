import { afterEach, describe, expect, it } from 'vitest';
import {
  agentLabel,
  callingAgent,
  connectedAgents,
  forgetAgents,
  noteAgentAttached,
  noteAgentDetached,
  onAgentsChange,
  runAsAgent,
} from './coding-agents.js';

afterEach(() => forgetAgents());

describe('which coding agent is on the other end', () => {
  it('names the agents people know by their own names, and keeps any other name as sent', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code');
    expect(agentLabel('codex-mcp-client')).toBe('Codex');
    expect(agentLabel('cursor-vscode')).toBe('Cursor');
    expect(agentLabel('gemini-cli-mcp-client')).toBe('Gemini CLI');
    expect(agentLabel('Antigravity')).toBe('Antigravity');
    expect(agentLabel('windsurf-client')).toBe('Windsurf');
    expect(agentLabel('Visual Studio Code')).toBe('VS Code');
    expect(agentLabel('my-own-agent')).toBe('my-own-agent');
  });

  it('lists each attached agent once, and forgets one when its connection closes', () => {
    const heard: string[][] = [];
    const off = onAgentsChange(() => heard.push(connectedAgents()));
    noteAgentAttached('a1', 'claude-code');
    noteAgentAttached('a2', 'claude-code');
    noteAgentAttached('a3', 'cursor-vscode');
    expect(connectedAgents()).toEqual(['Claude Code', 'Cursor']);
    noteAgentDetached('a3');
    expect(connectedAgents()).toEqual(['Claude Code']);
    off();
    expect(heard.length).toBe(4);
  });

  it('knows which agent the current call came from, and falls back to the only one attached', async () => {
    noteAgentAttached('a1', 'claude-code');
    noteAgentAttached('a2', 'codex');
    await runAsAgent('a2', () => {
      expect(callingAgent()).toBe('Codex');
      return Promise.resolve();
    });
    // Two attached and no call to say which: unknown, never a guess.
    expect(callingAgent()).toBeUndefined();
    noteAgentDetached('a2');
    expect(callingAgent()).toBe('Claude Code');
  });
});
