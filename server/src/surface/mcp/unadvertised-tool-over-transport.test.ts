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
import { TOOL_SURFACE, type ToolSurface } from '@/surface/tools/tool-surface.js';
import { tableForSurface, type ToolDeps } from '@/surface/tools/tools.js';
import { ReticleTool } from '@reticlehq/core';

/** Enough of the dep surface to construct a server; no tool is actually executed here. */
const toolDepsForTest = (): ToolDeps =>
  ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

const openServer = async (
  surface: ToolSurface = TOOL_SURFACE.DEFAULT,
): Promise<{
  client: import('@modelcontextprotocol/sdk/client/index.js').Client;
  close: () => Promise<void>;
}> => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  // The table follows the surface: `merged` is the one surface whose tools are not the shipped
  // ones, and handing it the default table would serve a different product than a daemon does.
  const server = createMcpServer(toolDepsForTest(), surface, false, tableForSurface(surface));
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

/**
 * The same question on the surface a daemon actually serves, where the hatch is gone.
 *
 * `resolveToolSurface` falls back to `merged`, and `advertisedTools` drops `reticle_run` there — so
 * the advice above, which is right on the surface it was written for, becomes the defect it exists
 * to remove. Driven against a released daemon with one call: `reticle_tools { names:
 * ["reticle_coverage"] }` answered "through reticle_run if it is not advertised under this profile"
 * while `reticle_verify` was advertised and `reticle_run` was not registered at all (#978).
 *
 * Over the transport rather than against the builders, and for the reason this file already gives:
 * the message can be perfect and never reach the wire. It also catches the half a builder test
 * cannot see — `liveCallValues` rewrites every string leaving this server, and it does NOT rewrite
 * `reticle_run`, because that name has nowhere to be redirected to.
 */
describe('the closed default surface, driven the way an agent drives it', () => {
  /** The hatch, matched on a word boundary — `reticle_run_export` is a different tool entirely. */
  const NAMES_THE_HATCH = /\breticle_run\b/;

  it('advertises no dispatch hatch — the premise the assertions below rest on', async () => {
    const { client, close } = await openServer(TOOL_SURFACE.MERGED);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).not.toContain(ReticleTool.RUN);
      expect(names).toContain(ReticleTool.TOOLS);
    } finally {
      await close();
    }
  });

  it('resolves a merged name without sending the agent to a tool it was not given', async () => {
    const { client, close } = await openServer(TOOL_SURFACE.MERGED);
    try {
      const reply = await replyText(
        client.callTool({ name: ReticleTool.TOOLS, arguments: { names: [ReticleTool.COVERAGE] } }),
      );
      expect(reply, 'the issue’s own reproduction').not.toMatch(NAMES_THE_HATCH);
      expect(reply, 'the call that does work here').toContain(ReticleTool.VERIFY);
    } finally {
      await close();
    }
  });

  it('answers an old name called directly with a route that exists on this surface', async () => {
    const { client, close } = await openServer(TOOL_SURFACE.MERGED);
    try {
      const reply = await replyText(client.callTool({ name: ReticleTool.DIFF, arguments: {} }));
      expect(reply).not.toMatch(/not found/i);
      expect(reply).not.toMatch(NAMES_THE_HATCH);
    } finally {
      await close();
    }
  });
});
