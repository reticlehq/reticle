import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, type ToolDeps } from './tools/tools.js';
import { filterTools, TOOL_PROFILE, type ToolProfile } from './tools/profiles.js';
import { runTool } from './tools/invoke-tool.js';
import { log } from './log.js';

const SERVER_INFO = { name: 'iris', version: '0.3.10' } as const;

/**
 * Build an MCP server exposing the Iris tools, backed by the given session manager. The optional
 * profile trims the surface to the core loop; FULL (default) exposes every tool, so existing
 * callers are unaffected.
 */
export function createMcpServer(
  deps: ToolDeps,
  profile: ToolProfile = TOOL_PROFILE.FULL,
): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of filterTools(TOOLS, profile)) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await runTool(tool, deps, args);
          return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          log('tool_error', { tool: tool.name, error: message });
          return {
            isError: true,
            content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
          };
        }
      },
    );
  }
  return server;
}
