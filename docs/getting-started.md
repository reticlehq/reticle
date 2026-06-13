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
- [Step 6 — Make your app agent-legible](#step-6--make-your-app-agent-legible-optional-high-leverage)
- [Common setups at a glance](#common-setups-at-a-glance)
- [Troubleshooting](#troubleshooting)

---

## What you're setting up

Three pieces, each tiny:

```text
┌─────────────┐   MCP    ┌──────────────────────┐   WebSocket   ┌─────────────────────┐
│ coding agent │◀───────▶│ iris bridge + server  │◀─────────────▶│ your app + @syrin/    │
│ (Claude Code)│  stdio  │  (npx @syrin/server)   │  localhost    │ browser SDK (dev)    │
└─────────────┘          └──────────────────────┘  :4400        └─────────────────────┘
```

1. **The MCP server** (`@syrin/server`) — your agent launches it; it hosts the tools _and_ the
   WebSocket bridge your app connects to. You don't run it by hand; the agent does.
2. **The SDK** (`@syrin/browser`) — a few lines in your app's dev entry point.
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
    "iris": { "command": "npx", "args": ["@syrin/iris"] },
  },
}
```

**Cursor** — `~/.cursor/mcp.json` (or project `.cursor/mcp.json`):

```jsonc
{
  "mcpServers": {
    "iris": { "command": "npx", "args": ["@syrin/iris"] },
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

Install the one package as a dev dependency (it includes the SDK, React adapter, source-mapping
plugins, the spec runner, and the MCP server):

```bash
npm i -D @syrin/iris     # or: pnpm add -D @syrin/iris
```

Then call `iris.connect()` once, in dev only. Where you put it depends on your framework.

### Vite + React

In your entry file (`src/main.tsx`):

```ts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { iris } from '@syrin/iris';
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
      void import('@syrin/iris').then(({ iris }) => iris.connect({ session: 'my-app' }));
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
import { iris } from '@syrin/iris';
if (location.hostname === 'localhost') iris.connect({ session: 'my-app' });
```

Or, with no build step, a script tag pointed at the bridge:

```html
<script type="module">
  import { iris } from 'https://esm.sh/@syrin/iris';
  iris.connect({ session: 'my-app' });
</script>
```

> **Want to watch the agent work?** Add `present: true` to `iris.connect()` for a glowing
> border, a synthetic cursor that flies to targets, click/hover effects, and a narration HUD.
> See [usage §16](usage.md#16-presenter-mode-narration--fake-clock-watch--control).

---

## Step 3 — (React) component & source-file mapping

This is optional but high-value: it lets `iris_inspect` map a DOM element back to the
**React component and the source file:line** — so when the agent finds a problem, it knows
which file to edit. (The React adapter ships with `@syrin/iris` — nothing extra to install.)

```ts
import { install as installIrisReact } from '@syrin/iris';
if (import.meta.env.DEV) installIrisReact(); // call before iris.connect()
```

**React ≤ 18:** that's all — it uses React's dev `_debugSource`.

**React 19:** React removed `_debugSource`, so add the Babel plugin (also bundled in
`@syrin/iris`, at `@syrin/iris/babel`) to stamp the source onto elements in dev:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import irisSource from '@syrin/iris/babel';

export default defineConfig({
  plugins: [react({ babel: { plugins: [irisSource] } })],
});
```

> **Next.js:** verified on **Next.js 15 / React 19 (app router, SWC)**. For source-file
> mapping, use `@syrin/iris/next` instead of the Babel plugin — it adds a **dev-only webpack
> pre-loader that keeps SWC** and stamps `data-iris-source` so `iris_inspect` returns
> `file:line` (e.g. `app/page.tsx:30`):
>
> ```js
> // next.config.mjs
> import irisNext from '@syrin/iris/next';
> /** @type {import('next').NextConfig} */
> const nextConfig = {};
> export default irisNext.withIris(nextConfig); // no-op in production
> ```
>
> Component identity works with or without it (Next's internal wrappers are filtered out so
> you see your components, e.g. just `Page`).

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

## Step 6 — Make your app agent-legible (optional, high-leverage)

The basics above work with zero app changes. These four additions make the agent dramatically
faster and let it verify things the DOM can't express — they're what turn Iris from "usable"
into "magic." All are dev-only.

**1. Stable `data-testid` on key elements.** Agents target testids more reliably than visible
text (which changes with copy/i18n). Iris matches testids _exactly_.

```tsx
<button data-testid="refresh">Refresh</button>
```

**2. `iris.signal` for off-DOM facts.** When something matters but isn't visible — a save
committed, a webhook arrived, an edit applied, an LLM caption finished — emit a signal the
agent can assert on. This is the single highest-value instrumentation.

```ts
import { iris } from '@syrin/iris';
onSaved(() => iris.signal('order:saved', { id, total }));
// agent: iris_assert({ predicate: { kind: 'signal', name: 'order:saved', dataMatches: { id: '*' } } })
```

> **Recommended:** instead of importing `iris` into components, inject a `createIrisEmitter()`
> emitter and pair each commit with `commitAndSignal(...)` so the mutation↔signal can't drift —
> `iris.signal` stays the primitive underneath. See
> [integration-patterns.md](integration-patterns.md).

**3. `registerStore` so the agent reads state directly.** No need to broadcast a signal for
every fact — expose the store and the agent reads it via `iris_state`.

```ts
import { registerStore } from '@syrin/iris';
registerStore('cart', () => useCart.getState());
// agent: iris_state({ store: 'cart' })  → { stores: { cart: {...} } }
```

**4. `registerCapabilities` so a fresh agent learns the surface without reading source.**

```ts
import { registerCapabilities } from '@syrin/iris';
registerCapabilities({
  testids: ['refresh', 'cart-open', 'checkout'],
  signals: ['order:saved', 'cart:updated'],
  stores: ['cart'],
});
// agent: iris_capabilities()  → the whole testable surface
```

> **Multi-domain apps:** prefer `registerIrisDomain({ testids, signals, stores })` co-located in
> one `iris.ts` per domain — each self-registers and `iris_capabilities()` assembles the union, so
> there's no central map to forget. See [integration-patterns.md](integration-patterns.md).

> Watch the agent work: pass `present: true` to `iris.connect()` for a glowing border, a
> cursor that flies to targets, and a HUD; the agent can call `iris_narrate({ text })` to show
> its intent. See [usage §16](usage.md#16-presenter-mode-narration--fake-clock-watch--control).

> **Hover-gated UI (tooltips, hover menus, pointer drag)?** Synthetic events can't trigger
> native `onMouseEnter`. Enable **real input** by launching your browser with
> `--remote-debugging-port=9222` and setting `IRIS_CDP_URL` in the MCP server `env` — Iris then
> drives real pointer input and `iris_act` reports `inputMode:"real"`. See
> [usage §18](usage.md#18-real-input-mode--native-hover--drag-m58).

---

## Common setups at a glance

Everything below comes from the single `@syrin/iris` install.

| Stack                  | SDK connect                                | Source mapping                                          |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------- |
| Vite + React 19        | `iris.connect()` in `main.tsx` (dev)       | `install()` from `@syrin/iris` + `@syrin/iris/babel`    |
| Vite + React ≤18       | same                                       | `install()` from `@syrin/iris` (no plugin needed)       |
| Next.js (app router)   | `IrisDev` client component in layout (dev) | `@syrin/iris/next` (`withIris`) → component + file:line |
| Vue / Svelte / vanilla | `iris.connect()` at boot (dev)             | core works; framework adapters on the roadmap           |

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

- Wire up `@syrin/babel-plugin` (Step 3). Without it, only component identity is available.

**Nothing should run in production**

- Keep `iris.connect()` behind a dev guard (`import.meta.env.DEV` / `NODE_ENV`). The package
  is side-effect free and tree-shakes out when unused.
