import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from './log.js';

// These paths form the agent↔server wire contract. Keep in sync with skill/SKILL.md.
export const MCP_SSE_PATH = '/mcp/sse';
export const MCP_MESSAGE_PATH = '/mcp/message';
/** Local-only daemon introspection — `iris status` GETs this to show sessions + health at a glance. */
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
  /** Register the JSON the daemon returns from GET /status (live sessions + health for `iris status`). */
  attachStatus(provider: () => unknown): void;
  close(): Promise<void>;
}

/**
 * Creates a shared HTTP server that handles both the WebSocket bridge (browser SDK) and the
 * SSE MCP transport (Claude/agent). Does NOT call listen() — caller controls that.
 *
 * Routes:
 *   GET  /mcp/sse       → establishes SSE MCP session
 *   POST /mcp/message   → routes MCP messages to an active SSE session
 *   WS   /iris          → browser SDK connections (via WebSocketServer)
 */
export function createSharedServer(): SharedServer {
  type McpFactory = () => McpServer;
  let mcpFactory: McpFactory | undefined;
  let statusProvider: (() => unknown) | undefined;
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url === STATUS_PATH) {
      const body = JSON.stringify(statusProvider?.() ?? { running: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(body);
      return;
    }

    if (req.method === 'GET' && url === MCP_SSE_PATH) {
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
      res.on('close', () => {
        transports.delete(sid);
        transport.close().catch(() => undefined);
        mcpServer.close().catch(() => undefined);
        log('mcp_client_disconnected', { sessionId: sid });
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

    if (req.method === 'POST' && url.startsWith(MCP_MESSAGE_PATH)) {
      const parsed = new URL(url, 'http://localhost');
      const sessionId = parsed.searchParams.get('sessionId');
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

  return { httpServer, attachMcp, attachStatus, close };
}
