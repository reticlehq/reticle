import { LOOPBACK_HOST, MCP_SSE_PATH } from '@reticlehq/core';

const MCP_CONNECTION_HINT = 'If your agent has no reticle_* tools, connect over HTTP/SSE at';

/** The same connection hint for a running daemon in `status` and `doctor`. */
export function mcpConnectionHint(port: number): string {
  return `${MCP_CONNECTION_HINT} http://${LOOPBACK_HOST}:${String(port)}${MCP_SSE_PATH}`;
}
