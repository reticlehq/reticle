/**
 * A known-but-unadvertised tool name, called the way an agent calls it: over a real transport.
 *
 * `unadvertised-help.test.ts` covers the message BUILDER, which is pure and cannot tell whether the
 * message ever reaches the wire. It does not, unless the `tools/call` wrapper in `mcp.ts` is
 * installed — and that wrapper reaches into an SDK-private `_requestHandlers` map and returns
 * silently when the shape is absent. So the builder can be perfect, the patch dead, and every test
 * green while agents get `Tool <name> not found` and abandon tools that work.
 *
 * This is the same in-memory-transport pattern `mcp.test.ts` uses for the sibling arg-error patch;
 * this path just never got one.
 */

import { describe, expect, it } from 'vitest';
import { createMcpServer } from './mcp.js';
import { TOOL_SURFACE } from '../tools/tool-surface.js';
import type { ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';

/** Enough of the dep surface to construct a server; no tool is actually executed here. */
const toolDepsForTest = (): ToolDeps =>
  ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

const openServer = async (): Promise<{
  client: import('@modelcontextprotocol/sdk/client/index.js').Client;
  close: () => Promise<void>;
}> => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.DEFAULT);
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

/** Whatever the call produced, as text — a rejection and an isError result read the same to an agent. */
const replyText = async (call: Promise<unknown>): Promise<string> => {
  try {
    const result = await call;
    const content = (result as { content?: unknown }).content;
    const blocks = Array.isArray(content) ? content : [];
    return blocks
      .map((b) =>
        'object' === typeof b && null !== b ? String((b as { text?: unknown }).text) : '',
      )
      .join(' ');
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

describe('calling a known tool the default surface does not advertise', () => {
  it('answers with the call that works, never with "not found"', async () => {
    const { client, close } = await openServer();
    try {
      const advertised = await client.listTools();
      // The premise, asserted rather than assumed: if EXPLORE ever joins the default surface this
      // test would pass for the wrong reason.
      expect(
        advertised.tools.map((tool) => tool.name),
        'the tool under test must be un-advertised here',
      ).not.toContain(ReticleTool.EXPLORE);

      const reply = await replyText(client.callTool({ name: ReticleTool.EXPLORE, arguments: {} }));

      expect(reply, 'the SDK’s "not found" is the lie this patch exists to remove').not.toMatch(
        /not found/i,
      );
      expect(reply).toContain(ReticleTool.EXPLORE);
      expect(reply, 'it must name the hatch that works').toContain(ReticleTool.RUN);
    } finally {
      await close();
    }
  });
});
