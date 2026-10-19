/**
 * An agent's MCP connection closes, and the leases it took start their short grace.
 *
 * Before this, a closed connection only marked the agent detached. A reconnect is a new owner, so it
 * could never take its old lease back, and each old lease kept a browser window open for the full
 * TTL. An agent that reconnected five times in five minutes left five windows open.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMcpServer } from './mcp.js';
import { TOOL_SURFACE } from '@/surface/tools/tool-surface.js';
import { createMemoryFs } from '@/memory/project/memory-fs.js';
import type { ToolDeps } from '@/surface/tools/tools.js';

describe('closing an MCP connection', () => {
  it('detaches the leases this connection took', async () => {
    const detachOwner = vi.fn();
    const deps = {
      sessions: { resolve: () => undefined },
      fs: createMemoryFs().fs,
      reticleRoot: '/repo/.reticle',
      now: () => 1_000,
      pool: { detachOwner },
      attachId: 'attach-1',
    } as unknown as ToolDeps;
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const server = createMcpServer(deps, TOOL_SURFACE.ALL);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'c', version: '0' });
    await client.connect(clientTransport);
    expect(detachOwner).not.toHaveBeenCalled();

    await client.close();
    expect(detachOwner).toHaveBeenCalledWith('attach-1');
  });
});
