/**
 * A merged tool name, called over a real transport, REACHES the tool it merged into.
 *
 * The incident: driving the merchant-dashboard fixture on a session that had registered the tool
 * catalogue before the surface merged, four names answered `MCP error -32602 … was merged into …`
 * mid-drive — `reticle_snapshot`, `reticle_query`, `reticle_sessions`, `reticle_network` — while
 * `reticle_act_and_wait`, which did not move, kept working. A client registers tools once, at
 * connect, so this is every session that is open across such a release, not a stale-client edge
 * case. The half-working surface is the dangerous part: the agent reads it as a broken tool and
 * works around a product that is fine.
 *
 * `merged-name-redirect.test.ts` covers the TABLE, which is pure and cannot tell whether the call
 * is routed or merely described — and it was merely described: the wrapper in `mcp.ts` had the
 * target tool and the action in hand and returned prose. So the table can be perfect, every name
 * mapped, and every agent still blocked.
 *
 * Transport harness borrowed from `unadvertised-tool-over-transport.test.ts`, for the same reason
 * it exists there: the wrapper reaches into an SDK-private map and returns silently when the shape
 * is absent, so only a real call can prove it is installed.
 */

import { describe, expect, it } from 'vitest';
import { createMcpServer } from './mcp.js';
import { TOOL_SURFACE, MERGED_TOOL_NAMES } from '@/surface/tools/tool-surface.js';
import { mergedNameRedirect, retiredToolNames } from '@/surface/tools/merged-name-redirect.js';
import type { ToolDeps } from '@/surface/tools/tools.js';

/** Enough of the dep surface to construct a server; no tool is actually executed here. */
const toolDepsForTest = (): ToolDeps =>
  ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

const openServer = async (): Promise<{
  client: import('@modelcontextprotocol/sdk/client/index.js').Client;
  close: () => Promise<void>;
}> => {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(toolDepsForTest(), TOOL_SURFACE.MERGED);
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

/** The merged names whose target IS advertised here — the ones a client can still be holding. */
const dispatchableMergedNames = (): readonly string[] =>
  Object.keys(retiredToolNames()).filter((old) => {
    // A merge folds a group into one of its own members, so the surviving name appears on both
    // sides of the table. It is a live tool, not a name anybody has to be rescued from.
    if (MERGED_TOOL_NAMES.has(old)) return false;
    const moved = mergedNameRedirect(old);
    return moved?.action !== undefined && MERGED_TOOL_NAMES.has(moved.tool);
  });

describe('a tool name that moved when the surface merged', () => {
  it('routes to its replacement instead of answering "was merged into"', async () => {
    const names = dispatchableMergedNames();
    // If this is ever empty the assertion below is vacuous and would pass silently.
    expect(names.length).toBeGreaterThan(0);

    const { client, close } = await openServer();
    try {
      for (const old of names) {
        const text = await replyText(client.callTool({ name: old, arguments: {} }));
        expect(text, `${old} was described rather than called`).not.toContain('was merged into');
        expect(text, `${old} answered as a missing tool`).not.toContain('not found');
      }
    } finally {
      await close();
    }
  });

  it('keeps the old name off tools/list, so compatibility costs no schema', async () => {
    const { client, close } = await openServer();
    try {
      const listed = new Set((await client.listTools()).tools.map((t) => t.name));
      for (const old of dispatchableMergedNames()) {
        expect(listed.has(old), `${old} is advertised; it should only be answered`).toBe(false);
      }
    } finally {
      await close();
    }
  });
});
