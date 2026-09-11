import { TOOLS, type ToolDeps } from './tools.js';
import { runTool } from './invoke-tool.js';

/** Named error prefix when an invoker is asked for a tool that does not exist. No free strings. */
export const UNKNOWN_TOOL_ERROR = 'unknown reticle tool';

/**
 * Programmatic, MCP-free dispatch: (toolName, args) -> the same value the MCP handler returns.
 * This is the seam @reticlehq/test calls instead of standing up a stdio MCP transport.
 */
export type ToolInvoker = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Build an invoker over the shipped TOOLS table, bound to one ToolDeps. No stdio, no transport.
 * Unknown names reject with `${UNKNOWN_TOOL_ERROR}: <name>`; handler errors propagate unwrapped
 * (the MCP `{ isError, content }` envelope is a transport concern this layer deliberately skips).
 */
export function createToolInvoker(deps: ToolDeps): ToolInvoker {
  const byName = new Map(TOOLS.map((tool) => [tool.name, tool]));
  return (toolName, args) => {
    const tool = byName.get(toolName);
    if (tool === undefined) {
      return Promise.reject(new Error(`${UNKNOWN_TOOL_ERROR}: ${toolName}`));
    }
    return runTool(tool, deps, args);
  };
}
