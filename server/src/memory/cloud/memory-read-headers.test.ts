import { afterEach, describe, expect, it } from 'vitest';
import { forgetAgents, noteAgentAttached, runAsAgent } from '@/hooks/coding-agents.js';
import { MemoryReadHeader, memoryReadHeaders } from './memory-scope.js';

/*
 * A replay's memory read went without `x-reticle-agent`, so the platform credited three reads to
 * "an agent that did not name itself" although the MCP client had named itself. Every memory read
 * an agent's call makes names that agent.
 */
describe('the headers of a memory read', () => {
  afterEach(() => forgetAgents());

  it('name the agent whose call made it', async () => {
    noteAgentAttached('a1', 'persona-drive-r3');
    const headers = await runAsAgent('a1', () => Promise.resolve(memoryReadHeaders('rk_x')));
    expect(headers[MemoryReadHeader.AGENT]).toBe('persona-drive-r3');
    expect(headers['authorization']).toBe('Bearer rk_x');
  });

  it('name no agent when no agent made the call', () => {
    noteAgentAttached('a1', 'one');
    noteAgentAttached('a2', 'two');
    expect(memoryReadHeaders('rk_x')).not.toHaveProperty(MemoryReadHeader.AGENT);
  });
});
