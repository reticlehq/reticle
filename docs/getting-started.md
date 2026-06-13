# Getting Started with Iris

This walks you from zero to your agent verifying your app — step by step, with real code for
real frameworks. ~10 minutes.

- [What you're setting up](#what-youre-setting-up)
- [Prerequisites](#prerequisites)
- [Step 1 — Connect your coding agent (MCP)](#step-1--connect-your-coding-agent-mcp)
- [Step 2 — Embed the SDK in your app](#step-2--embed-the-sdk-in-your-app)
  - [Vite + React](#vite--react)
  - [Next.js](#nextjs)
  - [Plain / other frameworks](#plain--other-frameworks)
- [Step 3 — (React) component & source-file mapping](#step-3--react-component--source-file-mapping)
- [Step 4 — Run it & verify the connection](#step-4--run-it--verify-the-connection)
- [Step 5 — Your first verification](#step-5--your-first-verification)
- [Common setups at a glance](#common-setups-at-a-glance)
- [Troubleshooting](#troubleshooting)

---

## What you're setting up

Three pieces, each tiny:

```text
┌─────────────┐   MCP    ┌──────────────────────┐   WebSocket   ┌─────────────────────┐
│ coding agent │◀───────▶│ iris bridge + server  │◀─────────────▶│ your app + @iris/    │
│ (Claude Code)│  stdio  │  (npx @iris/server)   │  localhost    │ browser SDK (dev)    │
└─────────────┘          └──────────────────────┘  :4400        └─────────────────────┘
```

1. **The MCP server** (`@iris/server`) — your agent launches it; it hosts the tools _and_ the
   WebSocket bridge your app connects to. You don't run it by hand; the agent does.
2. **The SDK** (`@iris/browser`) — a few lines in your app's dev entry point.
3. **(Optional) React adapter + babel plugin** — so `iris_inspect` can tell the agent which
   component/file to edit.

Everything is **dev-only** and **localhost-only**. It's tree-shaken out of production builds.

## Prerequisites

- Node 18+ and a package manager (npm/pnpm/yarn).
- A coding agent that speaks MCP: Claude Code, Cursor, Windsurf, Claude Desktop, etc.
- A web app you run locally in dev (any framework; React gets the richest features).

---

## Step 1 — Connect your coding agent (MCP)

You don't start the server manually — your agent starts it via MCP. Add Iris to your agent's
MCP config.

**Claude Code** — create/edit `.mcp.json` in your project root:

```jsonc
{
  "mcpServers": {
    "iris": { "command": "npx", "args": ["@iris/server"] },
  },
}
```

**Cursor** — `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```jsonc
{
  "mcpServers": {
    "iris": { "command": "npx", "args": ["@iris/server"] },
  },
}
```

Other MCP clients (Windsurf, Claude Desktop, …) use the same `command`/`args` shape. Restart
the agent so it picks up the new server. When it launches Iris, the bridge starts listening
on `ws://localhost:4400`.

> Want a different port? Set `IRIS_PORT` in the server `env` and pass the same URL to
> `iris.connect({ url })` in Step 2.

---

## Step 2 — Embed the SDK in your app

Install it as a dev dependency:

```bash
npm i -D @iris/browser     # or: pnpm add -D @iris/browser
```

Then call `iris.connect()` once, in dev only. Where you put it depends on your framework.

### Vite + React

In your entry file (`src/main.tsx`):

```ts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { iris } from '@iris/browser';
import { App } from './App';

if (import.meta.env.DEV) {
  iris.connect({ session: 'my-app' }); // connects to ws://localhost:4400 by default
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

### Next.js

Create a tiny client component and mount it in your root layout, dev-only:

```tsx
// app/iris-dev.tsx
'use client';
import { useEffect } from 'react';

export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      void import('@iris/browser').then(({ iris }) => iris.connect({ session: 'my-app' }));
    }
  }, []);
  return null;
}
```

```tsx
// app/layout.tsx
import { IrisDev } from './iris-dev';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV === 'development' && <IrisDev />}
        {children}
      </body>
    </html>
  );
}
```

### Plain / other frameworks

Anywhere your app boots in dev:

```ts
import { iris } from '@iris/browser';
if (location.hostname === 'localhost') iris.connect({ session: 'my-app' });
```

Or, with no build step, a script tag pointed at the bridge:

```html
<script type="module">
  import { iris } from 'https://esm.sh/@iris/browser';
  iris.connect({ session: 'my-app' });
</script>
```

---

## Step 3 — (React) component & source-file mapping

This is optional but high-value: it lets `iris_inspect` map a DOM element back to the
**React component and the source file:line** — so when the agent finds a problem, it knows
which file to edit.

```bash
npm i -D @iris/react
```

```ts
import { install as installIrisReact } from '@iris/react';
if (import.meta.env.DEV) installIrisReact(); // call before iris.connect()
```

**React ≤ 18:** that's all — it uses React's dev `_debugSource`.

**React 19:** React removed `_debugSource`, so add the babel plugin to stamp the source onto
elements in dev:

```bash
npm i -D @iris/babel-plugin
```

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import irisSource from '@iris/babel-plugin';

export default defineConfig({
  plugins: [react({ babel: { plugins: [irisSource] } })],
});
```

> **Next.js note:** verified on **Next.js 15 / React 19 (app router, SWC)** — snapshot,
> query, act, observe, assert, network, console, and **component identity** all work. Next
> uses SWC, not Babel, so precise file:line mapping isn't available out of the box (an
> SWC-native plugin is on the roadmap); component-stack identity works without it, with Next's
> internal wrappers filtered out so you see your components.

---

## Step 4 — Run it & verify the connection

1. Start your app's dev server as usual (`npm run dev`).
2. Open it in the browser (the SDK connects when the page loads).
3. In your agent, ask it to confirm the connection:

> "List Iris sessions."

The agent calls `iris_sessions` and should see your tab:

```jsonc
{ "sessions": [{ "sessionId": "my-app", "url": "http://localhost:3000/", "title": "…" }] }
```

If the list is empty, see [Troubleshooting](#troubleshooting).

---

## Step 5 — Your first verification

Now just talk to your agent in plain language. For example:

> "Add a 'Refresh' button to the header that re-fetches the dashboard data, then use Iris to
> verify clicking it fires `GET /api/dashboard` and shows no console errors."

What the agent does under the hood:

```jsonc
// finds the button it just added
iris_query({ by: "role", value: "button", name: "Refresh" })   // → ref e12

// clicks it
iris_act({ ref: "e12", action: "click" })                       // → { since: 920 }

// verifies the reaction
iris_assert({ timeout_ms: 2000, predicate: { allOf: [
  { kind: "net", method: "GET", urlContains: "/api/dashboard", status: 200, since: 920 },
  { kind: "console", level: "error", absent: true }
]}})
// → { pass: true }
```

You get a real, evidence-backed answer — and if it fails, the agent sees the reason (e.g. the
call 404'd, or a `TypeError` in `Dashboard.tsx:88`) and can fix it and re-check.

That's the whole loop. From here, the [Usage Guide](usage.md) covers every tool, the full
predicate DSL, and a dozen real situations (login, long lists, eventual consistency, file
uploads, LLM calls, regressions, and more).

---

## Common setups at a glance

| Stack                  | SDK connect                                | Source mapping                                      |
| ---------------------- | ------------------------------------------ | --------------------------------------------------- |
| Vite + React 19        | `iris.connect()` in `main.tsx` (dev)       | `@iris/react` + `@iris/babel-plugin`                |
| Vite + React ≤18       | same                                       | `@iris/react` (no plugin needed)                    |
| Next.js (app router)   | `IrisDev` client component in layout (dev) | `@iris/react` (component identity; file:line later) |
| Vue / Svelte / vanilla | `iris.connect()` at boot (dev)             | core works; framework adapters on the roadmap       |

---

## Troubleshooting

**`iris_sessions` is empty / "no browser session connected"**

- Is your app actually running and open in a browser tab?
- Is `iris.connect()` running? (Check it's inside your dev guard and the guard is true.)
- Port mismatch? If you set `IRIS_PORT`, pass the same URL to
  `iris.connect({ url: 'ws://localhost:<port>/iris' })`.

**The agent can't find an element**

- Ask it to `iris_snapshot({ mode: "interactive" })` to see what's actionable.
- Add a `data-testid` to the element for a stable handle.
- Narrow with `scope` (a CSS selector or a ref).

**Assertions are flaky on async UIs**

- Use `timeout_ms` on `iris_assert` / `iris_wait_for`.
- Pass the `since` cursor returned by `iris_act` so only post-action events count.

**Source file isn't resolving on React 19**

- Wire up `@iris/babel-plugin` (Step 3). Without it, only component identity is available.

**Nothing should run in production**

- Keep `iris.connect()` behind a dev guard (`import.meta.env.DEV` / `NODE_ENV`). The package
  is side-effect free and tree-shakes out when unused.
