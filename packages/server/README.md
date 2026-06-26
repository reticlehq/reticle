# @syrin/iris-server

The [Iris](https://github.com/syrin-labs/iris) bridge + MCP server. It hosts a localhost WebSocket endpoint your app's `@syrin/iris-browser` SDK connects to, and exposes MCP tools your coding agent uses to look at, act on, observe, and assert against the live app.

```bash
npx @syrin/iris-server        # bridge on ws://localhost:4400, MCP over stdio
```

Point your agent at it (e.g. Claude Code `.mcp.json`):

```jsonc
{ "mcpServers": { "iris": { "command": "npx", "args": ["@syrin/iris-server", "mcp"] } } }
```

Tools: `iris_snapshot`, `iris_query`, `iris_inspect`, `iris_act`, `iris_act_sequence`, `iris_observe`, `iris_wait_for`, `iris_assert`, `iris_network`, `iris_console`, `iris_animations`, `iris_baseline_save`/`_list`, `iris_diff`, `iris_record_start`/`_stop`, `iris_explore`, `iris_sessions`.

See the [main README](https://github.com/syrin-labs/iris). MIT.
