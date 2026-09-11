/**
 * `reticle_context` answered over a real transport, the way an agent actually reaches it.
 *
 * The handler tests construct the tool directly, which cannot tell whether the name was registered,
 * whether the surface advertises it, or whether the session-exempt classification lets the call
 * through. A tool that is built and unreachable is indistinguishable from one that was never built,
 * and this repo has shipped that exact shape before: a channel wired end to end and dropped by the
 * layer nobody tested.
 *
 * Follows the in-memory-transport pattern of `unadvertised-tool-over-transport.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { createMcpServer } from './mcp.js';
import { TOOL_SURFACE } from '../tools/tool-surface.js';
import { ReticleTool } from '../tools/tool-names.js';
import { createMemoryFs } from '../project/memory-fs.js';
import type { ToolDeps } from '../tools/tools.js';

/** No session connected, which is the state the honest-empty answer is about. */
const toolDepsForTest = (): ToolDeps =>
  ({
    sessions: {
      resolve: () => {
        throw new Error('no session is connected');
      },
    },
    fs: createMemoryFs().fs,
    reticleRoot: '/repo/.reticle',
    now: () => 1_000,
  }) as unknown as ToolDeps;

const openServer = async (): Promise<{
  client: import('@modelcontextprotocol/sdk/client/index.js').Client;
  close: () => Promise<void>;
}> => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.ALL);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
};

describe('reticle_context over a real MCP transport', () => {
  it('is advertised on the extended surface and answers an honest empty context', async () => {
    const { client, close } = await openServer();
    try {
      const advertised = await client.listTools();
      expect(advertised.tools.map((tool) => tool.name)).toContain(ReticleTool.CONTEXT);

      const result = await client.callTool({ name: ReticleTool.CONTEXT, arguments: {} });
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        step: 0,
        established: [],
        proven: [],
        remaining: [],
      });
    } finally {
      await close();
    }
  }, 20_000);
});
