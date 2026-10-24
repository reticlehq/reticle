/**
 * An agent's MCP connection closes, and the leases it took start their short grace.
 *
 * Before this, a closed connection only marked the agent detached. A reconnect is a new owner, so it
 * could never take its old lease back, and each old lease kept a browser window open for the full
 * TTL. An agent that reconnected five times in five minutes left five windows open.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMcpServer, mcpServerFactoryFor } from './mcp.js';
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
      pool: { detachOwner, reattachOwner: vi.fn() },
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

  it('takes the leases back when the same attach id connects again', () => {
    const reattachOwner = vi.fn();
    const deps = {
      sessions: { resolve: () => undefined },
      fs: createMemoryFs().fs,
      reticleRoot: '/repo/.reticle',
      now: () => 1_000,
      pool: { detachOwner: vi.fn(), reattachOwner },
      attachId: 'attach-1',
    } as unknown as ToolDeps;
    createMcpServer(deps, TOOL_SURFACE.ALL);
    expect(reattachOwner).toHaveBeenCalledWith('attach-1');
  });
});

/**
 * The daemon builds one MCP server for each attach. A proxy that reconnects sends its id, and that id
 * must become the attach id, or the reconnect is a new owner and its leases close after the grace.
 */
describe('the daemon factory for MCP attaches', () => {
  function attachIds(proxyIds: (string | undefined)[]): string[] {
    const reattachOwner = vi.fn();
    const deps = {
      sessions: { resolve: () => undefined },
      fs: createMemoryFs().fs,
      reticleRoot: '/repo/.reticle',
      now: () => 1_000,
      pool: { detachOwner: vi.fn(), reattachOwner },
    } as unknown as ToolDeps;
    const factory = mcpServerFactoryFor(deps, TOOL_SURFACE.ALL, () => false);
    for (const proxyId of proxyIds) {
      factory(undefined, proxyId);
    }
    return reattachOwner.mock.calls.map(([id]) => String(id));
  }

  it('gives two attaches from one proxy the same attach id', () => {
    expect(attachIds(['proxy-a', 'proxy-a'])).toEqual(['proxy-a', 'proxy-a']);
  });

  it('gives different proxies different attach ids', () => {
    const [first, second] = attachIds(['proxy-a', 'proxy-b']);
    expect(first).not.toBe(second);
  });

  it('gives an attach with no proxy id a new id each time', () => {
    const [first, second] = attachIds([undefined, undefined]);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(second).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });
});
