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
/**
 * Query parameter on the SSE connect: one id per MCP proxy process. A reconnect from the same
 * process sends the same id, so the daemon knows it is the same agent coming back.
 */
export const PROXY_ID_PARAM = 'proxyId';
/**
 * How long the daemon waits after the last agent detaches before it ends the browser sessions. A
 * proxy that reconnects inside this window keeps them.
 */
export const AGENT_DETACH_GRACE_MS = 10_000;
