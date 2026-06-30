import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from './log.js';
import { isLoopbackPeer, requestToken, tokensMatch } from './token-auth.js';

// These paths form the agent↔server wire contract. Keep in sync with skill/SKILL.md.
export const MCP_SSE_PATH = '/mcp/sse';
export const MCP_MESSAGE_PATH = '/mcp/message';
/** Local-only daemon introspection — `reticle status` GETs this to show sessions + health at a glance. */
export const STATUS_PATH = '/status';

export interface SharedServer {
  readonly httpServer: http.Server;
  /**
   * Register a factory that creates a fresh McpServer per SSE connection.
   * The MCP SDK's Protocol layer only supports one transport per Server instance,
   * so each concurrent Claude Code client needs its own McpServer.
   * Must be called before listen().
   */
  attachMcp(factory: () => McpServer): void;
  /** Register the JSON the daemon returns from GET /status (live sessions + health for `reticle status`). */
  attachStatus(provider: () => unknown): void;
  /**
   * Register a callback fired when the AGENT presence changes — true when the first MCP client (any
   * agent: Codex/OpenCode/Claude/Hermes) connects, false when the last one disconnects. Agent-
   * independent: the MCP connection lives exactly as long as the agent session, so its presence IS
   * "is an agent attached?". The daemon uses this to tell the panel "agent live" vs "agent stopped".
   */
  attachAgentPresence(cb: (connected: boolean) => void): void;
  close(): Promise<void>;
}

/**
 * Creates a shared HTTP server that handles both the WebSocket bridge (browser SDK) and the
 * SSE MCP transport (Claude/agent). Does NOT call listen() — caller controls that.
 *
 * Routes:
 *   GET  /mcp/sse       → establishes SSE MCP session
 *   POST /mcp/message   → routes MCP messages to an active SSE session
 *   WS   /reticle          → browser SDK connections (via WebSocketServer)
 */
export function createSharedServer(options: { token?: string } = {}): SharedServer {
  type McpFactory = () => McpServer;
  let mcpFactory: McpFactory | undefined;
  let statusProvider: (() => unknown) | undefined;
  let agentPresence: ((connected: boolean) => void) | undefined;
  const transports = new Map<string, SSEServerTransport>();
  const token = options.token;

  // The agent control plane (MCP transport) and /status carry the same trust as the browser WS: a
  // loopback peer is trusted (the local stdio proxy and `reticle status` always dial 127.0.0.1), but any
  // non-loopback peer must present the pairing token. Without this, binding the daemon beyond loopback
  // (RETICLE_HOST) would expose reticle_act/reticle_navigate and session enumeration to the whole network even
  // though the WS demanded a token. When no token is configured the bind is loopback-only anyway.
  const authorized = (req: http.IncomingMessage, url: URL): boolean => {
    if (isLoopbackPeer(req.socket.remoteAddress)) return true;
    if (token === undefined) return false;
    return tokensMatch(token, requestToken(req, url));
  };

  const httpServer = http.createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, 'http://localhost');
    const path = url.pathname;

    if (path === STATUS_PATH || path === MCP_SSE_PATH || path === MCP_MESSAGE_PATH) {
      if (!authorized(req, url)) {
        res.writeHead(401, { 'Content-Type': 'text/plain' });
        res.end('unauthorized');
        return;
      }
    }

    if (req.method === 'GET' && path === STATUS_PATH) {
      const body = JSON.stringify(statusProvider?.() ?? { running: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && path === MCP_SSE_PATH) {
      if (mcpFactory === undefined) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('MCP server not ready');
        return;
      }
      // Fresh McpServer per connection: the MCP SDK's Protocol layer only supports
      // one active transport per Server instance, so concurrent clients each need
      // their own instance backed by the same shared ToolDeps.
      const mcpServer = mcpFactory();
      const transport = new SSEServerTransport(MCP_MESSAGE_PATH, res);
      const sid = transport.sessionId;
      transports.set(sid, transport);
      if (transports.size === 1) agentPresence?.(true); // first agent attached
      res.on('close', () => {
        transports.delete(sid);
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
        log('mcp_client_disconnected', { sessionId: sid });
        if (transports.size === 0) agentPresence?.(false); // last agent detached → it's the human's turn
      });
      mcpServer
        .connect(transport)
        .then(() => {
          log('mcp_client_connected', { sessionId: sid });
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log('mcp_connect_error', { error: message });
        });
      return;
    }

    if (req.method === 'POST' && path === MCP_MESSAGE_PATH) {
      const sessionId = url.searchParams.get('sessionId');
      if (sessionId === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('missing sessionId');
        return;
      }
      const transport = transports.get(sessionId);
      if (transport === undefined) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('session not found');
        return;
      }
      transport.handlePostMessage(req, res).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log('mcp_message_error', { error: message });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });

  function attachStatus(provider: () => unknown): void {
    statusProvider = provider;
  }

  function attachAgentPresence(cb: (connected: boolean) => void): void {
    agentPresence = cb;
  }

  function attachMcp(factory: McpFactory): void {
    mcpFactory = factory;
  }

  async function close(): Promise<void> {
    for (const transport of transports.values()) {
      await transport.close();
    }
    transports.clear();
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err !== undefined && err !== null) reject(err);
        else resolve();
      });
    });
  }

  return { httpServer, attachMcp, attachStatus, attachAgentPresence, close };
}
