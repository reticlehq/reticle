# @reticlehq/server

The [Reticle](https://github.com/reticlehq/reticle) bridge + MCP server. It hosts a localhost WebSocket endpoint your app's `@reticlehq/browser` SDK connects to, and exposes MCP tools your coding agent uses to look at, act on, observe, and assert against the live app.

```bash
npx @reticlehq/server init   # wire the project: SDK + build plugin + MCP registration
npx @reticlehq/server mcp    # MCP over stdio; auto-starts the bridge on ws://localhost:4400
```

The package installs a `reticle` bin, so inside a project `reticle mcp` and `npx @reticlehq/server mcp` are the same command. `reticle` is not a package name on npm.

Point your agent at it. On Claude Code, register it at user scope:

```bash
claude mcp add reticle -s user -- npx @reticlehq/server mcp
```

Default tools (18):

`reticle_sessions`, `reticle_snapshot`, `reticle_query`, `reticle_inspect`, `reticle_navigate`, `reticle_act`, `reticle_act_sequence`, `reticle_act_and_wait`, `reticle_observe`, `reticle_wait_for`, `reticle_assert`, `reticle_network`, `reticle_console`, `reticle_state`, `reticle_feedback`, `reticle_session`, `reticle_tools`, `reticle_run`.

Only `reticle_act_and_wait` and `reticle_assert` return a verdict; everything else moves or reads the app.

Another 30 tools ship but are not advertised, to keep the per-turn tool payload small: screenshots and visual diff, saved flows, recording, baselines, clock control, viewport, crawl, coverage, network mocking, leases and more. Reach any of them by name with `reticle_run`, list them with `reticle_tools`, or advertise the whole surface with `RETICLE_ADVERTISE_ALL_TOOLS=1` (this roughly doubles the per-turn tool payload).

See the [main README](https://github.com/reticlehq/reticle).

## License

[FSL-1.1-ALv2](./LICENSE) (source-available: free for any use except reselling Reticle itself; converts to Apache-2.0 after two years). Files under `dist/ee/` are enterprise features covered by the [Reticle Enterprise License](./LICENSE-ENTERPRISE) — free for development, testing, and evaluation; a license key activates them in production.
