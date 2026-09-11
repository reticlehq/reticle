/**
 * `reticle mcp` never answered `initialize`, and said nothing about why.
 *
 * Reported from the field on a SvelteKit app: the MCP client gave up after 60 seconds and NO tools
 * ran at all. Reproduced here — the cause is not the app, it is the daemon port:
 *
 *   a process that accepts connections but never serves the SSE endpoint
 *     -> initialize: TIMED OUT in 25004ms, stderr: (none)
 *
 * That is a wedged daemon, a foreign process on the port, or — the case already reported separately
 * — a daemon leaked by ANOTHER project. The proxy queues every client message until the daemon's
 * endpoint frame arrives, and `initialize` is a client message, so the whole handshake waits on a
 * thing that is never coming.
 *
 * A hang is worse than an error: the agent has no tools, no diagnosis, and nothing to retry. The
 * handshake must complete on its own, after which the FIRST TOOL CALL reports the real problem
 * through the no-session diagnostics that already exist and are good.
 *
 * Answering locally is safe because the proxy already replays the client's `initialize` to the
 * daemon whenever a session is established (see replayLines) — the daemon still gets its handshake.
 */

import { describe, expect, it } from 'vitest';
import { localInitializeResponse, drainLines } from './proxy-handshake.js';

interface InitResult {
  id?: unknown;
  result?: {
    protocolVersion?: unknown;
    capabilities?: { tools?: unknown };
    serverInfo?: { name?: unknown };
    instructions?: unknown;
  };
}
function answer(line: string, instructions?: string): InitResult {
  const parsed: unknown = JSON.parse(
    (instructions === undefined
      ? localInitializeResponse(line)
      : localInitializeResponse(line, instructions)) ?? '{}',
  );
  return parsed as InitResult;
}

describe('answering initialize without a daemon', () => {
  it('mirrors the id the client asked with', () => {
    expect(answer('{"jsonrpc":"2.0","id":7,"method":"initialize"}').id).toBe(7);
  });

  it('declares tool capability, so the client will actually call tools', () => {
    const parsed = answer('{"jsonrpc":"2.0","id":1,"method":"initialize"}');
    expect(parsed.result?.capabilities?.tools).toBeDefined();
    expect(parsed.result?.serverInfo?.name).toBeTruthy();
  });

  it('echoes the protocol version the client proposed', () => {
    // Answering with a version the client did not offer is its own handshake failure.
    const parsed = answer(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}',
    );
    expect(parsed.result?.protocolVersion).toBe('2024-11-05');
  });

  it('is null for anything that is not an initialize request', () => {
    expect(localInitializeResponse('{"jsonrpc":"2.0","id":2,"method":"tools/list"}')).toBeNull();
    expect(localInitializeResponse('not json')).toBeNull();
    // A notification has no id, so there is nothing to answer.
    expect(localInitializeResponse('{"jsonrpc":"2.0","method":"initialize"}')).toBeNull();
  });
});

/**
 * The handshake the proxy answers itself carried no `instructions` at all.
 *
 * A client reads `instructions` ONCE, at initialize. The proxy answers locally precisely when no
 * daemon is up yet — which is the first run, which is the population that has tools registered and
 * an app that is not instrumented. So the one block that tells them "having these tools is not the
 * same as being set up" was permanently absent for exactly them, and the daemon's later, correct
 * instructions arrive at a client that will never look again.
 */
describe('the locally-answered handshake carries the guidance', () => {
  const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

  it('passes the instructions through to the client', () => {
    expect(answer(INIT, 'DO THE THING FIRST').result?.instructions).toBe('DO THE THING FIRST');
  });

  it('omits the field rather than sending an empty one when there is nothing to say', () => {
    expect(answer(INIT, '').result?.instructions).toBeUndefined();
  });
});

/**
 * One oversized line froze the entire MCP link.
 *
 * The reader appended each chunk and then split the WHOLE accumulated buffer, so a single large line
 * cost O(n²) in its own size. Measured against the real proxy: ~8s for 32 MB, ~35s for 50 MB, event
 * loop pinned throughout — so every other tool call on that link hung with no response and no error,
 * which from the agent's side is the tool surface going away. There was also no cap at all, so the
 * buffer grew to whatever was sent.
 */
describe('reading lines from stdin', () => {
  it('returns nothing and keeps the partial line when no newline has arrived', () => {
    const out = drainLines('', 'half a message');
    expect(out.lines).toEqual([]);
    expect(out.rest).toBe('half a message');
    expect(out.overflowed).toBe(false);
  });

  it('splits only what is complete, carrying the remainder', () => {
    const out = drainLines('{"a":1}\n{"b"', ':2}\n{"c"');
    expect(out.lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(out.rest).toBe('{"c"');
  });

  it('joins a message split across chunks', () => {
    const first = drainLines('', '{"jsonrpc"');
    const second = drainLines(first.rest, ':"2.0"}\n');
    expect(second.lines).toEqual(['{"jsonrpc":"2.0"}']);
  });

  it('drops a line past the cap instead of accumulating it forever', () => {
    const out = drainLines('', 'x'.repeat(64), 32);
    expect(out.overflowed).toBe(true);
    expect(out.rest, 'the buffer must not keep growing').toBe('');
    expect(out.lines).toEqual([]);
  });

  /**
   * Resync after a discard, which is the half that makes dropping safe.
   *
   * Dropping the buffer is not enough on its own: the REST of that same oversized line is still
   * coming, and without a discarding state its tail arrives looking like a complete line. It then
   * gets forwarded to the daemon as a JSON-RPC message — a fragment of something nobody sent,
   * failing to parse, on a link where the client is waiting for answers to real requests. Worse than
   * the oversized line itself, because the line was at least identifiable as one message.
   */
  it('swallows the REST of a discarded line instead of forwarding its tail', () => {
    const first = drainLines('', 'x'.repeat(64), 32);
    expect(first.overflowed).toBe(true);
    expect(first.discarding, 'it must know it is mid-discard').toBe(true);

    // The tail of that same line, then a real message behind it.
    const second = drainLines(first.rest, `xxxx\n{"id":1}\n`, 32, first.discarding);
    expect(second.lines, 'the tail is not a message').toEqual(['{"id":1}']);
    expect(second.discarding).toBe(false);
  });

  it('stays in discard until a newline actually arrives', () => {
    let state = drainLines('', 'y'.repeat(64), 32);
    expect(state.discarding).toBe(true);
    for (const chunk of ['y'.repeat(40), 'y'.repeat(40)]) {
      state = drainLines(state.rest, chunk, 32, state.discarding);
      expect(state.lines).toEqual([]);
      expect(state.discarding, 'no newline yet, so still discarding').toBe(true);
      expect(state.rest, 'and nothing is accumulating').toBe('');
    }
    const done = drainLines(state.rest, `\n{"ok":1}\n`, 32, state.discarding);
    expect(done.lines).toEqual(['{"ok":1}']);
  });

  it('drops an oversized COMPLETED line but still delivers its neighbours', () => {
    const out = drainLines('', `ok\n${'x'.repeat(64)}\nalso-ok\n`, 32);
    expect(out.lines).toEqual(['ok', 'also-ok']);
    expect(out.overflowed).toBe(true);
  });

  /**
   * The property that matters is not "it is fast" — that is a statement about the machine. It is
   * that a chunk carrying no newline does no work proportional to the buffer already held. Asserted
   * structurally: the partial line is carried, and nothing is split.
   */
  it('does not rescan the accumulated buffer for a chunk that cannot complete a line', () => {
    let buffer = '';
    for (let i = 0; i < 200; i++) {
      const out = drainLines(buffer, 'y'.repeat(1000));
      expect(out.lines).toEqual([]);
      buffer = out.rest;
    }
    expect(buffer.length).toBe(200_000);
    const finished = drainLines(buffer, '\n');
    expect(finished.lines).toHaveLength(1);
    expect(finished.rest).toBe('');
  });
});
