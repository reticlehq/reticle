# Iris 👁️ — eyes for coding agents

> Let your AI coding agent **see and verify** your running web app — without screenshots.

Iris instruments your app (a tiny dev-only SDK), and exposes its real runtime behavior to
your coding agent over an **MCP server**. Instead of screenshotting and guessing, the agent
gets structured answers to: _what's on screen, what did the app just do, and did the right
thing happen?_

```
agent ──MCP──▶ iris bridge ──WebSocket──▶ @iris/browser (in your app)
                   ▲                              │
                   └────── observations ──────────┘
        (DOM · network · routes · console · animations · signals)
```

## Why

Driving a browser by screenshot is slow, costly, and blind to non-visual things (the API
call that fired, the console error, the route change). Iris reads what the app actually did
**in code** and lets the agent assert on it:

```jsonc
// "I clicked Pay — verify the whole reaction in one call"
iris_assert({
  timeout_ms: 2000,
  predicate: { allOf: [
    { kind: "net", method: "POST", urlContains: "/api/order", status: 200 },
    { kind: "element", query: { role: "dialog", name: "Order confirmed" }, state: "visible" },
    { kind: "console", level: "error", absent: true }
  ]}
})
// → { pass: true, evidence: { ... } }   (no screenshots, deterministic, cheap)
```

## Quick start

**1. Run the bridge + MCP server**

```bash
npx @iris/server          # starts on ws://localhost:4400, speaks MCP over stdio
```

**2. Point your coding agent at it** (e.g. Claude Code `.mcp.json`):

```jsonc
{ "mcpServers": { "iris": { "command": "npx", "args": ["@iris/server", "mcp"] } } }
```

**3. Embed the SDK in your app (dev only)**

```ts
import { iris } from '@iris/browser';
if (import.meta.env.DEV) iris.connect({ session: 'my-app' });
```

For React, optionally add the adapter for component/source mapping:

```ts
import { install } from '@iris/react';
if (import.meta.env.DEV) install();
```

That's it. Your agent can now `iris_snapshot`, `iris_act`, `iris_observe`, and `iris_assert`
against the live app.

## The tools

| Tool                                                | What it does                                                  |
| --------------------------------------------------- | ------------------------------------------------------------- |
| `iris_sessions`                                     | List connected tabs                                           |
| `iris_snapshot`                                     | Semantic accessibility snapshot (full / interactive / status) |
| `iris_query`                                        | Find elements (role/text/label/testid…)                       |
| `iris_inspect`                                      | Element detail + component + source file (with `@iris/react`) |
| `iris_act` / `iris_act_sequence`                    | Click / fill / type / select / submit / …                     |
| `iris_observe`                                      | Timeline of everything the app did in a window                |
| `iris_wait_for`                                     | Block until a predicate holds                                 |
| `iris_assert`                                       | Verify a predicate; returns evidence + diagnosis on failure   |
| `iris_network` / `iris_console` / `iris_animations` | Fast targeted lookups                                         |

## Packages

| Package                               | Role                                         |
| ------------------------------------- | -------------------------------------------- |
| [`@iris/browser`](packages/browser)   | Instrumentation SDK embedded in your app     |
| [`@iris/server`](packages/server)     | Bridge + MCP server (the `iris` CLI)         |
| [`@iris/react`](packages/react)       | React adapter: DOM → component → source file |
| [`@iris/protocol`](packages/protocol) | Shared wire contract (types + schemas)       |

## Status

Active development. Dev-only, localhost-only by default (see
[`skills/security.md`](skills/security.md)). Built as a pnpm + turbo TypeScript monorepo;
see [`WELCOME.md`](WELCOME.md) to develop, and `plan/ROADMAP.md` for what's next.

## License

MIT
