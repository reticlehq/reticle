import * as http from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log } from './log.js';

// These paths form the agent↔server wire contract. Keep in sync with skill/SKILL.md.
export const MCP_SSE_PATH = '/mcp/sse';
export const MCP_MESSAGE_PATH = '/mcp/message';

export interface SharedServer {
  readonly httpServer: http.Server;
  /** Register the MCP server — must be called before listen(). */
  attachMcp(server: McpServer): void;
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
  let attachedMcp: McpServer | undefined;
  const transports = new Map<string, SSEServerTransport>();

  const httpServer = http.createServer((req, res) => {
    const url = req.url ?? '/';

    if (req.method === 'GET' && url === MCP_SSE_PATH) {
      if (attachedMcp === undefined) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('MCP server not ready');
        return;
      }
      const transport = new SSEServerTransport(MCP_MESSAGE_PATH, res);
      const sid = transport.sessionId;
      transports.set(sid, transport);
      res.on('close', () => {
        transports.delete(sid);
        // Closing the transport lets McpServer release it so the next connect() succeeds.
        transport.close().catch(() => undefined);
        log('mcp_client_disconnected', { sessionId: sid });
      });
      attachedMcp
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

  function attachMcp(server: McpServer): void {
    attachedMcp = server;
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

  return { httpServer, attachMcp, close };
}
