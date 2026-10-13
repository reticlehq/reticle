import { afterEach, describe, expect, it } from 'vitest';
import { AgentClient, LaunchMethod } from '@reticlehq/core/telemetry';
import { forgetAgents, noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';
import { currentAgentClient, envAgentClient, launchMethodOf } from './agent-client.js';

afterEach(() => forgetAgents());

describe('currentAgentClient', () => {
  it('normalises the handshake name to a closed value, never the raw text', () => {
    noteAgentAttached('a', 'claude-code');
    expect(currentAgentClient({})).toBe(AgentClient.CLAUDE_CODE);
  });

  it('reports a client it does not know as other', () => {
    noteAgentAttached('a', 'my-secret-internal-agent');
    expect(currentAgentClient({})).toBe(AgentClient.OTHER);
  });

  it('credits the call to the connection it came over when two agents are attached', async () => {
    noteAgentAttached('a', 'claude-code');
    noteAgentAttached('b', 'cursor-vscode');
    expect(currentAgentClient({})).toBeUndefined();
    expect(await runAsAgent('b', () => Promise.resolve(currentAgentClient({})))).toBe(
      AgentClient.CURSOR,
    );
  });

  it('falls back to the marker an agent sets on what it spawns', () => {
    expect(currentAgentClient({ CLAUDECODE: '1' })).toBe(AgentClient.CLAUDE_CODE);
    expect(envAgentClient({ CURSOR_TRACE_ID: 'x' })).toBe(AgentClient.CURSOR);
    expect(envAgentClient({})).toBeUndefined();
  });

  it('prefers the handshake over the environment', () => {
    noteAgentAttached('a', 'codex-mcp-client');
    expect(currentAgentClient({ CLAUDECODE: '1' })).toBe(AgentClient.CODEX);
  });
});

describe('launchMethodOf', () => {
  it('buckets the entry path, which itself never leaves', () => {
    expect(
      launchMethodOf('/Users/a/.npm/_npx/abc/node_modules/@reticlehq/server/dist/cli.js'),
    ).toBe(LaunchMethod.NPX);
    expect(launchMethodOf('/usr/local/lib/node_modules/@reticlehq/server/dist/cli.js')).toBe(
      LaunchMethod.GLOBAL,
    );
    expect(
      launchMethodOf(
        'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@reticlehq\\server\\cli.js',
      ),
    ).toBe(LaunchMethod.GLOBAL);
    expect(launchMethodOf('/repo/app/node_modules/@reticlehq/server/dist/cli.js')).toBe(
      LaunchMethod.PROJECT,
    );
    expect(launchMethodOf('/repo/reticle/server/dist/cli.js')).toBe(LaunchMethod.OTHER);
    expect(launchMethodOf(undefined)).toBe(LaunchMethod.OTHER);
  });
});
