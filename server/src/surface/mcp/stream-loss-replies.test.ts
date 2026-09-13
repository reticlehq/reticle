/**
 * When the stream drops, every request the daemon never answered must be answered by US.
 *
 * Found by brute force, not by reading code: killing the daemon under a live client left 5 of 10
 * tool calls, and 20 of 20 concurrent ones, hanging until the client's own 30s timeout. The MCP
 * server stayed up the whole time — so this is not the disconnect that was already fixed, it is the
 * quieter half of the same experience. An agent does not see "MCP disconnected"; it sees a call that
 * never returns, which it cannot even react to.
 *
 * These requests are not recoverable by retrying them for the client: the daemon builds a FRESH MCP
 * session per SSE connection, so a reconnected session has never seen them and never will. Nor may
 * the proxy silently re-send: a `reticle_act` that already clicked would click twice, and inventing
 * a second action in someone's app is worse than reporting a failure.
 *
 * So the honest answer is an error carrying the request's own id — the client learns the call is
 * dead and can decide whether the action is safe to repeat. Silence is not an option; it is the one
 * outcome an agent cannot distinguish from "still working".
 */

import { describe, expect, it } from 'vitest';
import { PendingRequests, streamLossReplies } from './mcp-proxy.js';

describe('streamLossReplies', () => {
  it('answers every unanswered request, under its own id', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call' }));
    pending.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 'abc', method: 'tools/list' }));

    const replies = streamLossReplies(pending, 'sse_ended').map(
      (line) => JSON.parse(line) as { id: unknown; error?: { message?: string } },
    );

    expect(replies.map((r) => r.id).sort()).toEqual([7, 'abc']);
    for (const r of replies) expect(r.error?.message).toContain('sse_ended');
  });

  it('says nothing when nothing was in flight', () => {
    expect(streamLossReplies(new PendingRequests(), 'sse_ended')).toEqual([]);
  });

  /**
   * A request the daemon DID answer before the drop must not be answered twice — a duplicate id is a
   * protocol violation, and the client has already moved on.
   */
  it('never re-answers a request that was already answered', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
    pending.observeInbound(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    expect(streamLossReplies(pending, 'sse_ended')).toEqual([]);
  });

  /** Draining is part of it: the same request must not be failed again on the next drop. */
  it('clears what it has answered, so a second drop repeats nothing', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call' }));
    expect(streamLossReplies(pending, 'sse_ended')).toHaveLength(1);
    expect(streamLossReplies(pending, 'sse_closed')).toEqual([]);
  });
});
