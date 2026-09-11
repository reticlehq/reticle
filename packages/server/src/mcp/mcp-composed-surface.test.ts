import { describe, expect, it } from 'vitest';
import { createMcpServer } from './mcp.js';
import { advertisedTools } from './mcp.js';
import { TOOL_SURFACE } from '../tools/tool-surface.js';
import { TOOLS, type ToolDef, type ToolDeps } from '../tools/tools.js';
import { ReticleTool } from '../tools/tool-names.js';

/**
 * A consumer embedding this engine may serve its own tools alongside ours, on one surface.
 *
 * The tool surface is the product's front door, and the rule that governs it — there is ONE surface,
 * not a menu — is about US not shipping variants. It was never meant to stop a SERVICE built on this
 * engine from adding a tool that answers out of something this package has never heard of. Before
 * this, `createMcpServer` read the module-level `TOOLS` directly, so the only way to add one was to
 * edit that array: a fork, to append to a list.
 *
 * The composed list is threaded through instead of read, which also settles the harder half — the
 * `reticle_run` hatch and the unadvertised-tool help both need the FULL table, and a consumer tool
 * missing from either is a tool the agent is told does not exist.
 *
 * The profile trim does not apply to consumer tools, and that is deliberate. A profile is a decision
 * about how much of OUR 48-tool table is worth re-sending every turn; a consumer that appended three
 * tools has already made that decision by appending them. Filtering them by our `CORE_TOOL_NAMES`
 * would silently drop every one — the list is ours, and their names were never going to be in it.
 */

const CONSUMER_TOOL: ToolDef = {
  name: 'consumer_recall',
  description: 'Answers out of a store this package does not know about.',
  inputSchema: {},
  handler: () => Promise.resolve({ answer: 'remembered' }),
};

const depsForTest = (): ToolDeps =>
  ({ sessions: { resolve: () => ({ id: 'x' }) } }) as unknown as ToolDeps;

async function openServer(tools: readonly ToolDef[]): Promise<{
  names: string[];
  call: (name: string) => Promise<unknown>;
  close: () => Promise<void>;
}> {
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const server = createMcpServer(depsForTest(), TOOL_SURFACE.DEFAULT, false, tools);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'c', version: '0' });
  await client.connect(clientTransport);
  const listed = await client.listTools();
  return {
    names: listed.tools.map((t) => t.name),
    call: (name: string) => client.callTool({ name, arguments: {} }),
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('a composed tool surface', () => {
  it('advertises a consumer tool over the wire, under the default profile', async () => {
    const { names, close } = await openServer([...TOOLS, CONSUMER_TOOL]);
    try {
      expect(names).toContain(CONSUMER_TOOL.name);
      // Ours are still trimmed by the profile — appending a tool must not turn the default surface
      // into the full one, which would silently multiply every agent's per-turn bill.
      expect(names).toContain(ReticleTool.TOOLS);
      expect(names.length).toBeLessThan(TOOLS.length);
    } finally {
      await close();
    }
  });

  it('dispatches a call to the consumer handler', async () => {
    const { call, close } = await openServer([...TOOLS, CONSUMER_TOOL]);
    try {
      const result = (await call(CONSUMER_TOOL.name)) as { structuredContent?: unknown };
      expect(JSON.stringify(result)).toContain('remembered');
    } finally {
      await close();
    }
  });

  it('defaults to the shipped table, so every existing caller is unchanged', async () => {
    const { names, close } = await openServer(TOOLS);
    try {
      expect(names).not.toContain(CONSUMER_TOOL.name);
      expect(names).toContain(ReticleTool.TOOLS);
    } finally {
      await close();
    }
  });

  it('profile-trims our tools while keeping every consumer tool', () => {
    const composed = advertisedTools(TOOL_SURFACE.DEFAULT, [...TOOLS, CONSUMER_TOOL]);
    const ours = advertisedTools(TOOL_SURFACE.DEFAULT);

    expect(composed.map((t) => t.name)).toContain(CONSUMER_TOOL.name);
    // Exactly one more than ours: the consumer tool, and nothing of ours smuggled back in.
    expect(composed.length).toBe(ours.length + 1);
  });
});
