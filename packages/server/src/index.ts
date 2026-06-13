import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { IRIS_DEFAULT_PORT } from '@iris/protocol';
import { Bridge } from './bridge.js';
import { createMcpServer } from './mcp.js';
import { log } from './log.js';

export { IrisTool } from './tool-names.js';
export { RingBuffer } from './ring-buffer.js';
export { Bridge } from './bridge.js';
export { Session, SessionManager } from './session.js';
export { TOOLS } from './tools.js';
export type { ToolDeps, ToolDef } from './tools.js';
export { evaluatePredicate, waitForPredicate, PredicateSchema } from './predicate.js';
export type { Predicate, EvalResult } from './predicate.js';
export { buildReactionReport } from './reaction.js';

export interface StartOptions {
  port?: number;
  /** When false, skip the MCP stdio transport (used in tests). */
  mcp?: boolean;
}

export interface RunningServer {
  bridge: Bridge;
  close: () => Promise<void>;
}

/** Start the Iris bridge (browser WS endpoint) and, by default, the MCP stdio server. */
export async function start(options: StartOptions = {}): Promise<RunningServer> {
  const port = options.port ?? IRIS_DEFAULT_PORT;
  const bridge = new Bridge({ port });

  if (options.mcp !== false) {
    const server = createMcpServer({ sessions: bridge.sessions });
    await server.connect(new StdioServerTransport());
    log('mcp_connected', { port });
  }

  return {
    bridge,
    close: () => bridge.close(),
  };
}
