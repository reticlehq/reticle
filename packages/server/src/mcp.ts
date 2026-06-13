import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, type ToolDeps } from './tools.js';
import { log } from './log.js';

const SERVER_INFO = { name: 'iris', version: '0.3.6' } as const;

/** Build an MCP server exposing the Iris tools, backed by the given session manager. */
export function createMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer(SERVER_INFO);
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      async (args: Record<string, unknown>) => {
        try {
          const result = await tool.handler(deps, args);
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
