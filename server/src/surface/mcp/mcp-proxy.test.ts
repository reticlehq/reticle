import { describe, it, expect } from 'vitest';
import {
  SseFrameParser,
  buildSessionUrl,
  HandshakeReplay,
  reconnectDelayMs,
  RECONNECT_INITIALIZE_ID,
  MAX_RECONNECT_ATTEMPTS,
  PendingRequests,
} from './mcp-proxy.js';

/**
 * What the proxy owes the client at exit.
 *
 * A client that wrote `initialize` + `tools/list` and closed stdin in the same flush got only the
 * handshake answered — and exit status 0, which tells a supervising script the run succeeded. The
 * proxy exited the instant stdin ended, so whether anything was still in flight was never asked.
 */
describe('PendingRequests — what is still unanswered', () => {
  const req = (id: number | string, method: string): string =>
    JSON.stringify({ jsonrpc: '2.0', id, method });
  const res = (id: number | string): string => JSON.stringify({ jsonrpc: '2.0', id, result: {} });

  it('holds a request until its response goes back', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(req(1, 'tools/list'));
    expect(pending.unanswered).toEqual(['1']);
    pending.observeInbound(res(1));
    expect(pending.unanswered).toEqual([]);
  });

  it('ignores notifications — no id means nothing is owed', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    );
    expect(pending.unanswered).toEqual([]);
  });

  it('tracks each id separately, so one answer does not clear the other', () => {
    const pending = new PendingRequests();
    pending.observeOutbound(req(1, 'initialize'));
    pending.observeOutbound(req('two', 'tools/list'));
    pending.observeInbound(res(1));
    expect(pending.unanswered).toEqual(['"two"']);
  });

  it('ignores unparseable lines rather than throwing on them', () => {
    const pending = new PendingRequests();
    pending.observeOutbound('not json');
    pending.observeInbound('not json either');
    expect(pending.unanswered).toEqual([]);
  });
});

/**
 * The MCP front door. Every JSON-RPC message the agent sends is framed by SseFrameParser, and a bug in
 * the chunk-boundary or line-ending handling would silently corrupt or drop it — yet the framing was
 * only ever exercised end-to-end. These pin the edge cases a socket makes hard to reproduce on demand.
 */
describe('SseFrameParser — MCP front-door framing', () => {
  const dataOf = (frames: { data: string }[]): string[] => frames.map((f) => f.data);

  it('parses a single event:/data: frame terminated by a blank line', () => {
    const p = new SseFrameParser();
    expect(p.push('event: endpoint\ndata: /session/abc\n\n')).toEqual([
      { event: 'endpoint', data: '/session/abc' },
    ]);
  });

  it('defaults the event name to "message" when only data: is present', () => {
    const p = new SseFrameParser();
    expect(p.push('data: {"jsonrpc":"2.0"}\n\n')).toEqual([
      { event: 'message', data: '{"jsonrpc":"2.0"}' },
    ]);
  });

  it('holds a frame split ACROSS chunks until the terminating blank line arrives', () => {
    const p = new SseFrameParser();
    // A field is split mid-line, and the frame is not complete until the blank line in a later chunk.
    expect(p.push('event: mess')).toEqual([]);
    expect(p.push('age\ndata: {"id":')).toEqual([]);
    expect(p.push('1}\n')).toEqual([]);
    expect(p.push('\n')).toEqual([{ event: 'message', data: '{"id":1}' }]);
  });

  it('normalises CRLF and bare CR line endings', () => {
    const p = new SseFrameParser();
    expect(p.push('event: x\r\ndata: a\r\n\r\n')).toEqual([{ event: 'x', data: 'a' }]);
    const q = new SseFrameParser();
    expect(q.push('data: b\r\r')).toEqual([{ event: 'message', data: 'b' }]);
  });

  it('accumulates multi-line data: fields newline-joined', () => {
    const p = new SseFrameParser();
    expect(p.push('data: line1\ndata: line2\n\n')).toEqual([
      { event: 'message', data: 'line1\nline2' },
    ]);
  });

  it('ignores id:/retry:/comment lines (not needed for the bridge)', () => {
    const p = new SseFrameParser();
    expect(p.push('id: 7\nretry: 3000\n:comment\ndata: real\n\n')).toEqual([
      { event: 'message', data: 'real' },
    ]);
  });

  it('emits multiple frames from one chunk and does not emit an empty frame', () => {
    const p = new SseFrameParser();
    // Two complete frames plus a leading blank line (no data → no frame).
    expect(dataOf(p.push('\ndata: one\n\ndata: two\n\n'))).toEqual(['one', 'two']);
  });

  it('resets event/data between frames (a bare data frame after a named one is "message")', () => {
    const p = new SseFrameParser();
    p.push('event: endpoint\ndata: /s\n\n');
    expect(p.push('data: next\n\n')).toEqual([{ event: 'message', data: 'next' }]);
  });
});

/**
 * The proxy used to `process.exit(0)` the moment the SSE stream ended, even though the daemon stayed
 * up — the agent's tools vanished mid-session and only a human running `/mcp` could bring them back.
 * Reconnecting means re-establishing a session with a FRESH McpServer, which has never seen the
 * client's `initialize`. Replaying that handshake is what makes the reconnect invisible to the client;
 * suppressing the replayed response is what stops a duplicate JSON-RPC id from reaching its stdout.
 */
describe('HandshakeReplay — surviving a dropped SSE stream', () => {
  const INIT = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"x"}}';
  const INITIALIZED = '{"jsonrpc":"2.0","method":"notifications/initialized"}';

  it('replays nothing before the client has initialized', () => {
    expect(new HandshakeReplay().replayLines()).toEqual([]);
  });

  it('replays the initialize under a reserved id so the response can be told apart', () => {
    const r = new HandshakeReplay();
    r.observeOutbound(INIT);
    r.observeOutbound(INITIALIZED);
    const lines = r.replayLines();
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      id: RECONNECT_INITIALIZE_ID,
      method: 'initialize',
      params: { protocolVersion: 'x' },
    });
    expect(lines[1]).toBe(INITIALIZED);
  });

  it('replays the initialize even when the client never sent notifications/initialized', () => {
    const r = new HandshakeReplay();
    r.observeOutbound(INIT);
    expect(r.replayLines()).toHaveLength(1);
  });

  it('suppresses the replayed response, exactly once, and passes real traffic through', () => {
    const r = new HandshakeReplay();
    r.observeOutbound(INIT);
    r.replayLines();
    const echo = `{"jsonrpc":"2.0","id":${JSON.stringify(RECONNECT_INITIALIZE_ID)},"result":{}}`;
    expect(r.shouldSuppressInbound(echo)).toBe(true);
    // A second frame with the same id is no longer ours — passing it through beats swallowing a real reply.
    expect(r.shouldSuppressInbound(echo)).toBe(false);
    expect(r.shouldSuppressInbound('{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')).toBe(false);
  });

  it('suppresses a fresh id after every reconnect, not just the first', () => {
    const r = new HandshakeReplay();
    r.observeOutbound(INIT);
    r.replayLines();
    r.shouldSuppressInbound(`{"jsonrpc":"2.0","id":${JSON.stringify(RECONNECT_INITIALIZE_ID)}}`);
    r.replayLines(); // second drop → replay again
    expect(
      r.shouldSuppressInbound(`{"jsonrpc":"2.0","id":${JSON.stringify(RECONNECT_INITIALIZE_ID)}}`),
    ).toBe(true);
  });

  it('ignores unparseable lines rather than throwing on them', () => {
    const r = new HandshakeReplay();
    r.observeOutbound('not json');
    expect(r.replayLines()).toEqual([]);
    expect(r.shouldSuppressInbound('not json')).toBe(false);
  });

  it('keeps the FIRST initialize when the client sends another (the session identity is the first)', () => {
    const r = new HandshakeReplay();
    r.observeOutbound(INIT);
    r.observeOutbound(
      '{"jsonrpc":"2.0","id":9,"method":"initialize","params":{"protocolVersion":"y"}}',
    );
    expect(JSON.parse(r.replayLines()[0] ?? '')).toMatchObject({
      params: { protocolVersion: 'x' },
    });
  });
});

describe('reconnectDelayMs', () => {
  it('backs off with the attempt number and never exceeds the cap', () => {
    expect(reconnectDelayMs(1)).toBeLessThan(reconnectDelayMs(3));
    expect(reconnectDelayMs(MAX_RECONNECT_ATTEMPTS)).toBeLessThanOrEqual(5_000);
    expect(reconnectDelayMs(1)).toBeGreaterThan(0);
  });
});

describe('buildSessionUrl', () => {
  it('turns a path into a loopback URL on the daemon port, leaves an absolute URL untouched', () => {
    expect(buildSessionUrl('/messages?sessionId=abc', 4460)).toBe(
      'http://127.0.0.1:4460/messages?sessionId=abc',
    );
    expect(buildSessionUrl('http://127.0.0.1:9/x', 4460)).toBe('http://127.0.0.1:9/x');
  });

  it('refuses an endpoint frame with no URL in it, rather than answering with an empty one', () => {
    // `''` is not `null`, so an empty URL used to read as CONNECTED: the proxy posted every later
    // message to nowhere and nothing ever reconnected. null is the whole point of the return type.
    expect(buildSessionUrl('', 4460)).toBeNull();
    expect(buildSessionUrl('   \t ', 4460)).toBeNull();
  });
});
