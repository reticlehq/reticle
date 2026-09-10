/**
 * A locally-answered handshake left the client CONNECTED WITH NO TOOLS.
 *
 * Measured over one editor session on port 4400: 25 stream drops, 11 dormant, only 4 reconnects, and
 * 4 falls back to a local handshake. That last one is the user-visible failure — the proxy answers
 * `initialize` itself so the client does not hang, but it has no tool catalog, so `tools/list`
 * returns nothing and the agent sits there with Reticle "connected" and zero tools. That is exactly
 * the state where a human has to type /mcp.
 *
 * Answering the handshake was still right: a hang gives no tools AND no diagnosis. What was missing
 * is that the proxy has SEEN the catalog — every previous session's `tools/list` response went
 * through it — so it can answer from that until the daemon is back, and tell the client to refetch
 * the moment it is.
 *
 * The cache is deliberately in-memory and per-process: a stale catalog from a different Reticle
 * version would be its own confidently-wrong answer, and a proxy that has never seen a catalog
 * honestly has nothing to serve.
 */

import { describe, expect, it } from 'vitest';
import { isToolsListRequest, ToolCatalogCache } from './tool-catalog-cache.js';

const LIST_RESPONSE = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  result: { tools: [{ name: 'reticle_snapshot' }, { name: 'reticle_act' }] },
});

describe('the tool catalog the proxy has already seen', () => {
  it('remembers a tools/list response that passed through it', () => {
    const cache = new ToolCatalogCache();
    cache.observe(LIST_RESPONSE);
    expect(cache.has()).toBe(true);
  });

  it('answers a later tools/list with the same tools, under the NEW request id', () => {
    const cache = new ToolCatalogCache();
    cache.observe(LIST_RESPONSE);
    const answer = cache.answer('{"jsonrpc":"2.0","id":9,"method":"tools/list"}');
    expect(answer).not.toBeNull();
    const parsed: unknown = JSON.parse(answer ?? '{}');
    const msg = parsed as { id?: unknown; result?: { tools?: { name?: string }[] } };
    expect(msg.id, 'a response carrying the wrong id is not an answer').toBe(9);
    expect(msg.result?.tools?.map((t) => t.name)).toEqual(['reticle_snapshot', 'reticle_act']);
  });

  it('answers NOTHING when it has never seen a catalog', () => {
    // Inventing a tool list would be worse than an empty one: the agent would call tools that are
    // not there and read the refusals as product defects.
    const cache = new ToolCatalogCache();
    expect(cache.answer('{"jsonrpc":"2.0","id":9,"method":"tools/list"}')).toBeNull();
    expect(cache.has()).toBe(false);
  });

  it('ignores anything that is not a tools/list request', () => {
    const cache = new ToolCatalogCache();
    cache.observe(LIST_RESPONSE);
    expect(cache.answer('{"jsonrpc":"2.0","id":9,"method":"tools/call"}')).toBeNull();
    expect(cache.answer('not json')).toBeNull();
  });

  it('ignores a response that is not a tool list', () => {
    const cache = new ToolCatalogCache();
    cache.observe('{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05"}}');
    cache.observe('{"jsonrpc":"2.0","id":2,"error":{"code":-32000}}');
    expect(cache.has()).toBe(false);
  });

  it('takes the newest catalog it sees', () => {
    const cache = new ToolCatalogCache();
    cache.observe(LIST_RESPONSE);
    cache.observe(
      JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'reticle_only' }] } }),
    );
    const parsed: unknown = JSON.parse(
      cache.answer('{"jsonrpc":"2.0","id":1,"method":"tools/list"}') ?? '{}',
    );
    expect((parsed as { result?: { tools?: { name?: string }[] } }).result?.tools).toHaveLength(1);
  });

  it('recognises a tools/list request, so enumeration can be recorded when one arrives', () => {
    // `reticle status` needs this fact: a client that starts Reticle and never lists its tools is a
    // reportable state, and the request line is the only place enumeration is observable at all.
    expect(isToolsListRequest('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')).toBe(true);
    expect(isToolsListRequest('{"jsonrpc":"2.0","id":1,"method":"tools/call"}')).toBe(false);
    expect(isToolsListRequest('not json')).toBe(false);
  });
});
