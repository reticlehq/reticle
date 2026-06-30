# Getting Started with Reticle

This walks you from zero to your agent verifying your app — step by step, with real code for real frameworks. ~10 minutes.

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
│ coding agent │◀───────▶│  reticle bridge + server │◀─────────────▶│ your app + the Reticle │
│ (Claude Code)│  stdio  │   (npx @reticlehq/core)   │  localhost    │   SDK (dev only)    │
└─────────────┘          └──────────────────────┘  :4400        └─────────────────────┘
```

It all ships in **one package, `@reticlehq/core`**:

1. **The MCP server** — your agent launches it with `npx @reticlehq/core`; it hosts the tools _and_ the WebSocket bridge your app connects to. You don't run it by hand; the agent does.
2. **The SDK** — `import { reticle } from '@reticlehq/core'`, a few lines in your app's dev entry point.
3. **(Optional) React adapter + source-mapping** — so `reticle_inspect` can tell the agent which component/file to edit (also in `@reticlehq/core`).

Everything is **dev-only** and **localhost-only**. It's tree-shaken out of production builds.

## Prerequisites

- Node 18+ and a package manager (npm/pnpm/yarn).
- A coding agent that speaks MCP: Claude Code, Cursor, Windsurf, Claude Desktop, etc.
- A web app you run locally in dev (any framework; React gets the richest features).

---

## Fastest path — `reticle init`

From your project root:

```bash
npx @reticlehq/core init
```

It detects your framework, package manager, and React version, then:

- **registers the Reticle MCP server once, globally, for each agent you have installed** — Claude Code (`claude mcp add reticle -s user`) and/or Cursor (`~/.cursor/mcp.json`) — so every project on this machine gets it; you never re-add it per project,
- installs `@reticlehq/core` as a dev dependency,
- **Vite:** adds the `reticle()` plugin to your config — which wires source mapping _and_ `reticle.connect()` for you, so there is nothing else to edit,
- **Next / other:** creates the dev component and prints the exact `withReticle` / mount / connect snippets to paste (it never half-edits a build config).

The bridge + MCP server is a single process that serves all your projects, so it's registered at **user scope**, not in a per-project `.mcp.json`. Only the SDK (the `reticle()` plugin / connect call) is added per project.

Re-running is safe (already-registered/already-patched steps are skipped). Preview without writing via `npx @reticlehq/core init --dry-run`. Flags: `--port N`, `--no-mcp`, `--no-install`, `--yes`.

Then restart your dev server and skip to [Step 4](#step-4--run-it--verify-the-connection). The manual steps below explain what `init` sets up, if you prefer to wire it yourself.

---

## Step 1 — Connect your coding agent (MCP), once

You don't start the server manually — your agent starts it via MCP. Register Reticle **once, at the user (global) scope** so every project picks it up — there's nothing to add per project.

**Claude Code** — one command:

```bash
claude mcp add reticle -s user -- npx @reticlehq/core mcp
```

(`reticle init` runs exactly this for you. `-s user` is what makes it global; drop it for a project-local registration instead.)

**Cursor** — add to your global `~/.cursor/mcp.json` (not per-project; `reticle init` writes this for you):

```jsonc
{
  "mcpServers": {
    "reticle": { "command": "npx", "args": ["@reticlehq/core", "mcp"] },
  },
}
```

Other MCP clients (Windsurf, Claude Desktop, …) use the same `command`/`args` shape. Restart the agent so it picks up the new server. When it launches Reticle, the bridge starts listening on `ws://localhost:4400`.

> Want a different port? Set `RETICLE_PORT` in the server `env` and pass the same URL to `reticle.connect({ url })` in Step 2.

---

## Step 2 — Embed the SDK in your app

Install the one package as a dev dependency (it includes the SDK, React adapter, source-mapping plugins, the spec runner, and the MCP server):

```bash
npm i -D @reticlehq/core     # or: pnpm add -D @reticlehq/core
```

Then call `reticle.connect()` once, in dev only. Where you put it depends on your framework.

### Vite + React

**Recommended — the Vite plugin (one line, does everything).** Add `reticle()` to your `vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reticle } from '@reticlehq/core/vite';

export default defineConfig({
  plugins: [react(), reticle()],
});
```

This injects `reticle.connect()` for you _and_ handles React 19 source mapping (Step 3) — so there's no entry-file edit and no separate Babel setup. `apply: 'serve'` means it's dropped from `vite build` entirely, so it can never reach production. (This is exactly what `reticle init` adds.)

<details>
<summary>Prefer to wire it by hand instead of the plugin?</summary>

In your entry file (`src/main.tsx`), call `connect()` in dev only:

```ts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { reticle, SESSION_AUTO } from '@reticlehq/core';
import { App } from './App';

if (import.meta.env.DEV) {
  // SESSION_AUTO gives this tab a unique session id, so multiple apps/tabs never collide.
  reticle.connect({ session: SESSION_AUTO }); // connects to ws://localhost:4400 by default
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

On React 19 you then also need the source-mapping Babel plugin from Step 3. The Vite plugin above bundles both, which is why it's the recommended path.

</details>

### Next.js

Create a tiny client component and mount it in your root layout, dev-only:

```tsx
// app/reticle-dev.tsx
'use client';
import { useEffect } from 'react';

export function ReticleDev() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'development') {
      // SESSION_AUTO = a unique id per tab, so several Next apps/tabs never collide on one session.
      void import('@reticlehq/core').then(({ reticle, SESSION_AUTO }) =>
        reticle.connect({ session: SESSION_AUTO }),
      );
    }
  }, []);
  return null;
}
```

```tsx
// app/layout.tsx
import { ReticleDev } from './reticle-dev';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {process.env.NODE_ENV === 'development' && <ReticleDev />}
        {children}
      </body>
    </html>
  );
}
```

### Plain / other frameworks

Anywhere your app boots in dev:

```ts
import { reticle, SESSION_AUTO } from '@reticlehq/core';
if (location.hostname === 'localhost') reticle.connect({ session: SESSION_AUTO });
```

Or, with no build step, a script tag pointed at the bridge:

```html
<script type="module">
  import { reticle, SESSION_AUTO } from 'https://esm.sh/@reticlehq/core';
  reticle.connect({ session: SESSION_AUTO });
</script>
```

> **Want to watch the agent work?** Add `present: true` to `reticle.connect()` for a glowing border, a synthetic cursor that flies to targets, click/hover effects, and a narration HUD. See [usage §16](usage.md#16-presenter-mode-narration--fake-clock-watch--control).

### Running multiple apps at once

It's common to have several apps open in dev — a few Next.js and React projects, or multiple tabs of the same app. Reticle handles this cleanly **as long as each connection has a unique session id**, which is exactly what `SESSION_AUTO` gives you (a fresh id per tab). The examples above all use it, so you get this for free. When more than one app is connected, an Reticle tool call targets the focused / most recently active one automatically, or you can pass an explicit `sessionId` to target a specific app.

**Two separate projects, fully isolated.** If you want each repo to have its own independent Reticle bridge (separate sessions, separate `.reticle/` workspace), give each project its own port. Set the same port in both the MCP server config and the app's connection:

```jsonc
// project-b/.mcp.json — give this project its own bridge port
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["-y", "@reticlehq/core", "mcp"],
      "env": { "RETICLE_PORT": "4401" },
    },
  },
}
```

```ts
// project-b's app — dial the same port
reticle.connect({ session: SESSION_AUTO, url: 'ws://localhost:4401/reticle' });
```

Project A stays on the default `4400`, project B on `4401` — they never touch each other. (A port that is already in use now fails fast with a clear error instead of hanging, so a misconfiguration is obvious.)

---

## Step 3 — (React) component & source-file mapping

This is optional but high-value: it lets `reticle_inspect` map a DOM element back to the **React component and the source file:line** — so when the agent finds a problem, it knows which file to edit. (The React adapter ships with `@reticlehq/core` — nothing extra to install.)

```ts
import { install as installReticleReact } from '@reticlehq/core';
if (import.meta.env.DEV) installReticleReact(); // call before reticle.connect()
```

**React ≤ 18:** that's all — it uses React's dev `_debugSource`.

**React 19:** React removed `_debugSource`, so the source has to be stamped at build time. **If you added the `reticle()` Vite plugin in Step 2, this is already handled — skip ahead.** Otherwise add the Babel plugin (also bundled in `@reticlehq/core`, at `@reticlehq/core/babel`) to stamp the source onto elements in dev:

```ts
// vite.config.ts
import react from '@vitejs/plugin-react';
import reticleSource from '@reticlehq/core/babel';

export default defineConfig({
  plugins: [react({ babel: { plugins: [reticleSource] } })],
});
```

> **Next.js:** verified on **Next.js 15 / React 19 (app router, SWC)**. For source-file mapping, use `@reticlehq/core/next` instead of the Babel plugin — it adds a **dev-only webpack pre-loader that keeps SWC** and stamps `data-reticle-source` so `reticle_inspect` returns `file:line` (e.g. `app/page.tsx:30`):
>
> ```js
> // next.config.mjs
> import reticleNext from '@reticlehq/core/next';
> /** @type {import('next').NextConfig} */
> const nextConfig = {};
> export default reticleNext.withReticle(nextConfig); // no-op in production
> ```
>
> Component identity works with or without it (Next's internal wrappers are filtered out so you see your components, e.g. just `Page`).

---

## Step 4 — Run it & verify the connection

1. Start your app's dev server as usual (`npm run dev`).
2. Open it in the browser (the SDK connects when the page loads).
3. In your agent, ask it to confirm the connection:

> "List Reticle sessions."

The agent calls `reticle_sessions` and should see your tab:

```jsonc
{ "sessions": [{ "sessionId": "my-app", "url": "http://localhost:3000/", "title": "…" }] }
```

If the list is empty, see [Troubleshooting](#troubleshooting).

---

## Step 5 — Your first verification

Now just talk to your agent in plain language. For example:

> "Add a 'Refresh' button to the header that re-fetches the dashboard data, then use Reticle to verify clicking it fires `GET /api/dashboard` and shows no console errors."

What the agent does under the hood:

```jsonc
// finds the button it just added
reticle_query({ by: "role", value: "button", name: "Refresh" })   // → ref e12

// clicks it
reticle_act({ ref: "e12", action: "click" })                       // → { since: 920 }

// verifies the reaction
reticle_assert({ timeout_ms: 2000, predicate: { allOf: [
  { kind: "net", method: "GET", urlContains: "/api/dashboard", status: 200, since: 920 },
  { kind: "console", level: "error", absent: true }
]}})
// → { pass: true }
```

You get a real, evidence-backed answer — and if it fails, the agent sees the reason (e.g. the call 404'd, or a `TypeError` in `Dashboard.tsx:88`) and can fix it and re-check.

That's the whole loop. From here, the [Usage Guide](usage.md) covers every tool, the full predicate DSL, and a dozen real situations (login, long lists, eventual consistency, file uploads, LLM calls, regressions, and more).

---

## Step 6 — Make your app agent-legible (optional, high-leverage)

The basics above work with zero app changes. These four additions make the agent dramatically faster and let it verify things the DOM can't express — they're what turn Reticle from "usable" into "magic." All are dev-only.

**1. Stable `data-testid` on key elements.** Agents target testids more reliably than visible text (which changes with copy/i18n). Reticle matches testids _exactly_.

```tsx
<button data-testid="refresh">Refresh</button>
```

**2. `reticle.signal` for off-DOM facts.** When something matters but isn't visible — a save committed, a webhook arrived, an edit applied, an LLM caption finished — emit a signal the agent can assert on. This is the single highest-value instrumentation.

```ts
import { reticle } from '@reticlehq/core';
onSaved(() => reticle.signal('order:saved', { id, total }));
// agent: reticle_assert({ predicate: { kind: 'signal', name: 'order:saved', dataMatches: { id: '*' } } })
```

> **Recommended:** instead of importing `reticle` into components, inject a `createReticleEmitter()` emitter and pair each commit with `commitAndSignal(...)` so the mutation↔signal can't drift — `reticle.signal` stays the primitive underneath. See [integration-patterns.md](integration-patterns.md).

**3. `registerStore` so the agent reads state directly.** No need to broadcast a signal for every fact — expose the store and the agent reads it via `reticle_state`.

```ts
import { registerStore } from '@reticlehq/core';
registerStore('cart', () => useCart.getState());
// agent: reticle_state({ store: 'cart' })  → { stores: { cart: {...} } }
```

**4. `registerCapabilities` so a fresh agent learns the surface without reading source.**

```ts
import { registerCapabilities } from '@reticlehq/core';
registerCapabilities({
  testids: ['refresh', 'cart-open', 'checkout'],
  signals: ['order:saved', 'cart:updated'],
  stores: ['cart'],
});
// agent: reticle_capabilities()  → the whole testable surface
```

> **Multi-domain apps:** prefer `registerReticleDomain({ testids, signals, stores })` co-located in one `reticle.ts` per domain — each self-registers and `reticle_capabilities()` assembles the union, so there's no central map to forget. See [integration-patterns.md](integration-patterns.md).

> Watch the agent work: pass `present: true` to `reticle.connect()` for a glowing border, a cursor that flies to targets, and a HUD; the agent can call `reticle_narrate({ text })` to show its intent. See [usage §16](usage.md#16-presenter-mode-narration--fake-clock-watch--control).

> **Hover-gated UI (tooltips, hover menus, pointer drag)?** Synthetic events can't trigger native `onMouseEnter`. Enable **real input** by launching your browser with `--remote-debugging-port=9222` and setting `RETICLE_CDP_URL` in the MCP server `env` — Reticle then drives real pointer input and `reticle_act` reports `inputMode:"real"`. See [usage §18](usage.md#18-real-input-mode--native-hover--drag-m58).

---

## Going further

Once the loop works, these turn ad-hoc runs into a maintained suite:

- **[Flows, recorder & self-healing](flows.md)** — record a golden path once; Reticle saves it to a git-checked `.reticle/` flow anchored on testid+signal, replays it (with legible drift), and `reticle_flow_heal` repairs renamed anchors.
- **[Testing with `@reticlehq/test`](testing.md)** — declarative `reticleTest` specs you run headless / in CI; flows can _become_ the specs.
- **[Human-in-the-loop control](human-control.md)** — with `present: true`, pause / message / end the agent from the floating panel.
- **[Integration patterns](integration-patterns.md)** — the recommended zero-prod-bundle emit adapter, store-layer signals, and incremental adoption.

---

## Common setups at a glance

Everything below comes from the single `@reticlehq/core` install.

| Stack | SDK connect | Source mapping |
| --- | --- | --- |
| Vite + React (any) | `reticle()` plugin (auto) — or `connect()` | `reticle()` plugin handles it (incl. React 19) |
| Next.js (app router) | `ReticleDev` client component in layout (dev) | `@reticlehq/core/next` (`withReticle`) → component + file:line |
| Vue / Svelte / vanilla | `reticle.connect()` at boot (dev) | core works; framework adapters on the roadmap |

---

## Troubleshooting

**`reticle_sessions` is empty / "no browser session connected"**

- Run **`reticle status`** — it shows whether the daemon is up and which tabs are connected (url, health, pending flagged bugs) at a glance. No connected sessions means the SDK isn't reaching the bridge.
- Is your app actually running and open in a browser tab?
- Is `reticle.connect()` running? (Check it's inside your dev guard and the guard is true.)
- Port mismatch? If you set `RETICLE_PORT`, pass the same URL to `reticle.connect({ url: 'ws://localhost:<port>/reticle' })`.
- Need to restart the daemon? **`reticle stop`** cleans it up — no `pkill` needed.

The errors Reticle returns to the agent now carry a `recovery` hint for this exact situation (and for multiple/unknown sessions, a throttled tab, a missing baseline) — so the agent knows the next move.

**The agent can't find an element**

- Ask it to `reticle_snapshot({ mode: "interactive" })` to see what's actionable.
- Add a `data-testid` to the element for a stable handle.
- Narrow with `scope` (a CSS selector or a ref).

**Assertions are flaky on async UIs**

- Use `timeout_ms` on `reticle_assert` / `reticle_wait_for`.
- Pass the `since` cursor returned by `reticle_act` so only post-action events count.

**Source file isn't resolving on React 19**

- Wire up `@reticlehq/babel-plugin` (Step 3). Without it, only component identity is available.

**Nothing should run in production**

- Keep `reticle.connect()` behind a dev guard (`import.meta.env.DEV` / `NODE_ENV`). The package is side-effect free and tree-shakes out when unused.
