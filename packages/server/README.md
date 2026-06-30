# @reticlehq/server

The [Reticle](https://github.com/reticlehq/reticle) bridge + MCP server. It hosts a localhost WebSocket endpoint your app's `@reticlehq/browser` SDK connects to, and exposes MCP tools your coding agent uses to look at, act on, observe, and assert against the live app.

```bash
npx @reticlehq/server        # bridge on ws://localhost:4400, MCP over stdio
```

Point your agent at it (e.g. Claude Code `.mcp.json`):

```jsonc
{ "mcpServers": { "reticle": { "command": "npx", "args": ["@reticlehq/server", "mcp"] } } }
```

Tools: `reticle_snapshot`, `reticle_query`, `reticle_inspect`, `reticle_act`, `reticle_act_sequence`, `reticle_observe`, `reticle_wait_for`, `reticle_assert`, `reticle_network`, `reticle_console`, `reticle_animations`, `reticle_baseline_save`/`_list`, `reticle_diff`, `reticle_record_start`/`_stop`, `reticle_explore`, `reticle_sessions`.

See the [main README](https://github.com/reticlehq/reticle). MIT.
