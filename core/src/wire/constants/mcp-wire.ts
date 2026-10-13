/**
 * The agent-to-daemon MCP wire: the paths the daemon's HTTP plane serves and the stdio proxy forwards,
 * and the header that says which project a call comes from. Kept apart from constants.ts, which is at
 * its line cap, and re-exported from it so every import stays as it was.
 */

/** Agent↔server MCP wire paths — served by the daemon HTTP plane, forwarded by the stdio proxy. */
export const MCP_SSE_PATH = '/mcp/sse';
export const MCP_MESSAGE_PATH = '/mcp/message';
/** Directory the MCP proxy was started in. One daemon serves every project, and this says which. */
export const MCP_CLIENT_DIRECTORY_HEADER = 'x-reticle-client-directory';
