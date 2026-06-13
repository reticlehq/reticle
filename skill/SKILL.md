# Iris — Integration Skill

> **This file is for your coding agent, not for you.**
> Copy the `skill/` directory to `~/.claude/skills/iris/` (or your agent's skills folder).
> Then invoke it with `/iris` (Claude Code) or whatever trigger your agent uses.
> The agent will handle everything from there.

---

## What you are doing when this skill runs

You are integrating **Iris** into the user's existing web project. Iris is a dev-only SDK
that gives AI coding agents structured, evidence-backed vision into a running web app —
without screenshots, without Playwright, without a separate test runner.

By the end of this skill the user will have:

1. The Iris MCP server configured so you (the agent) automatically gain browser tools.
2. The SDK wired into their app so any browser tab connects to those tools.
3. A validated connection (you can see and act on the running app).
4. Optionally: capabilities registered and a first recorded flow saved.

The whole thing should take about **10 minutes**.

---

## What Iris is (your background knowledge)

**The three-piece architecture:**

```
┌─────────────────┐   MCP/stdio   ┌──────────────────────┐   WebSocket   ┌──────────────────────┐
│  coding agent   │◀─────────────▶│  Iris bridge + MCP   │◀─────────────▶│  user's app + SDK    │
│  (you, Claude)  │               │  npx @syrin/iris      │  localhost    │  @syrin/iris (dev)   │
└─────────────────┘               └──────────────────────┘  :4400        └──────────────────────┘
```

- **The MCP server** — you launch it via the MCP config; it hosts the tools AND the WebSocket
  bridge. The user does not run it by hand.
- **The SDK** — a few lines in the app's dev entry point. Tree-shaken out of production builds.
- **The React adapter** (optional) — maps DOM elements back to component name + `file:line`.

**What Iris lets you do:**

| Category          | Tools                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------- |
| Observe the page  | `iris_snapshot` (semantic tree), `iris_query` (find element), `iris_inspect` (box + source) |
| Drive the page    | `iris_act` (click/fill/press/…), `iris_act_sequence`, `iris_scroll_to`                      |
| Watch reactions   | `iris_observe` (DOM/net/route/console/animation/signal timeline), `iris_wait_for`           |
| Assert outcomes   | `iris_assert` (element, signal, network, route, console, animation — structured evidence)   |
| Read app state    | `iris_state` (live Zustand/Redux/Pinia store, no broadcast needed)                          |
| Network & console | `iris_network`, `iris_console` (full filtered logs)                                         |
| Animations        | `iris_animations` (what's running, named)                                                   |
| Flows             | `iris_record_start/stop`, `iris_flow_save`, `iris_flow_replay`, `iris_flow_heal`            |
| Session           | `iris_sessions`, `iris_session`, `iris_end_session`                                         |
| Regression        | `iris_baseline_save`, `iris_diff`, `iris_visual_diff` (needs `iris drive`)                  |
| Explore           | `iris_crawl` (autonomous smart monkey — finds 404s, console errors, dead controls)          |
| Human loop        | `iris_narrate` (presenter HUD), `iris_messages` (drain human notes)                         |

**What Iris cannot do:**

- **It is dev-only.** The SDK must be behind a dev guard (`import.meta.env.DEV`, `NODE_ENV`).
  Never instrument production.
- **It needs a running browser tab.** The app must be open in the browser and the SDK must
  have connected. It does not launch browsers by itself (unless you use `iris drive`).
- **Synthetic events cannot trigger native pointer state.** Hover-gated menus and drag-and-drop
  need `iris drive` + `IRIS_CDP_URL` for real input. Synthetic clicks and fills work everywhere.
- **No built-in screenshotter in always-on mode.** `iris_screenshot` and `iris_visual_diff`
  require a CDP-driven browser (`iris drive <url>` or `IRIS_CDP_URL`).
- **It does not replace an E2E suite** for CI on every PR. It's an agent's live instrument —
  the two are complementary (Iris generates the flows; CI runs them headlessly).

---

## Step 0 — Ask these questions before doing anything

Ask ALL of them in a single message. Do not start installing until you have the answers.

```
1. What framework/stack is this app?
   a) Vite + React (specify React 18 or 19)
   b) Next.js (specify version + app/pages router)
   c) Vite + Vue
   d) Vite + Svelte
   e) SvelteKit
   f) Remix
   g) Plain HTML / vanilla JS / other

2. What package manager are you using?
   npm | pnpm | yarn | bun

3. What command starts your dev server, and what URL does it open on?
   (e.g. "npm run dev" → http://localhost:3000)

4. Do you already have data-testid attributes on your key elements?
   (If yes, Iris reuses them — nothing to add. If no, we'll add a handful to the most
   important interactive elements as part of setup.)

5. How do you want to use Iris?
   a) Quick spot-check — verify a specific thing the agent just built, interactive.
   b) Pair programming — present mode on, watch the agent work in the browser.
   c) Full automation — record flows of the golden paths, replay in CI, catch regressions.
   d) All of the above.
```

Based on the answers, tailor the steps below. Skip anything that does not apply.

---

## Step 1 — Configure the MCP server

Check whether a `.mcp.json` already exists in the project root. If it does, add the `iris`
entry to the existing `mcpServers` object. If it does not, create it.

```jsonc
// .mcp.json
{
  "mcpServers": {
    "iris": { "command": "npx", "args": ["@syrin/iris"] },
  },
}
```

> **Port conflict?** If port 4400 is taken by another service, add an `env` block:
> `"env": { "IRIS_PORT": "58432" }` — then pass the same port to `iris.connect()` in Step 3.

Tell the user: "I've created `.mcp.json`. Please run `/mcp` (Claude Code) or restart your
agent so it picks up the new server. Let me know when it says 'connected to iris'."

Wait for confirmation before continuing.

---

## Step 2 — Install the SDK

Install `@syrin/iris` as a dev dependency. Use the package manager from the questionnaire.

```bash
# npm
npm install --save-dev @syrin/iris

# pnpm
pnpm add -D @syrin/iris

# yarn
yarn add --dev @syrin/iris

# bun
bun add --dev @syrin/iris
```

---

## Step 3 — Wire up the SDK (framework-specific)

Pick the section that matches the user's framework.

### Vite + React (18 or 19)

Create `src/iris-dev.ts` (or `.tsx`):

```ts
// src/iris-dev.ts — dev-only, tree-shaken out of production builds
import { iris, registerCapabilities, registerStore } from '@syrin/iris';

// Call this once, in your app's dev entry point.
// Add data-testids, signals, and store names as you discover them.
export function installIris(): void {
  iris.connect({
    session: 'my-app', // identifies the tab to the agent
    present: false, // set true to show the glow border + HUD (pair programming)
  });

  // Tell the agent what's testable — it reads this via iris_capabilities().
  registerCapabilities({
    testids: [], // fill in as you add data-testid attributes
    signals: [], // fill in as you add iris.signal() calls
    stores: [], // fill in as you register stores
  });
}
```

In `src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

if (import.meta.env.DEV) {
  // Dynamically imported so the module (and @syrin/iris) is tree-shaken in production.
  void import('./iris-dev').then(({ installIris }) => installIris());
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

**React 19 source mapping** (optional but very useful — lets `iris_inspect` return `file:line`):

In `vite.config.ts`, add the Babel plugin:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import irisSource from '@syrin/iris/babel';

export default defineConfig({
  plugins: [react({ babel: { plugins: [irisSource] } })],
});
```

Also call `install()` before `iris.connect()` in `iris-dev.ts`:

```ts
import { iris, registerCapabilities, install } from '@syrin/iris';

export function installIris(): void {
  install(); // React adapter — DOM ref → component → file:line
  iris.connect({ session: 'my-app' });
  registerCapabilities({ testids: [], signals: [], stores: [] });
}
```

### Next.js (app router, any version)

Create `app/iris-dev.tsx`:

```tsx
// app/iris-dev.tsx — loaded only in dev via a conditional in layout.tsx
'use client';
import { useEffect } from 'react';

export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@syrin/iris').then(({ iris, registerCapabilities, install }) => {
      install();
      iris.connect({ session: 'my-app', present: false });
      registerCapabilities({ testids: [], signals: [], stores: [] });
    });
  }, []);
  return null;
}
```

In `app/layout.tsx`:

```tsx
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

**Source-file mapping for Next.js** (component + `file:line` in `iris_inspect`):

```js
// next.config.mjs
import irisNext from '@syrin/iris/next';
const nextConfig = {};
export default irisNext.withIris(nextConfig); // no-op in production
```

### Vite + Vue 3

```ts
// src/iris-dev.ts
import { iris, registerCapabilities } from '@syrin/iris';

export function installIris(): void {
  iris.connect({ session: 'my-app' });
  registerCapabilities({ testids: [], signals: [], stores: [] });
}
```

In `src/main.ts`:

```ts
import { createApp } from 'vue';
import App from './App.vue';

if (import.meta.env.DEV) {
  void import('./iris-dev').then(({ installIris }) => installIris());
}

createApp(App).mount('#app');
```

### Vite + Svelte / SvelteKit

```ts
// src/iris-dev.ts
import { iris, registerCapabilities } from '@syrin/iris';

export function installIris(): void {
  iris.connect({ session: 'my-app' });
  registerCapabilities({ testids: [], signals: [], stores: [] });
}
```

**Svelte / Vite:** call from `src/main.ts` behind `import.meta.env.DEV`.

**SvelteKit:** call from `src/routes/+layout.svelte`:

```svelte
<script>
  import { browser, dev } from '$app/environment';
  if (browser && dev) {
    import('../iris-dev').then(({ installIris }) => installIris());
  }
</script>
<slot />
```

### Plain HTML / vanilla JS / no bundler

Add before your app scripts, in dev only:

```html
<script type="module">
  if (location.hostname === 'localhost') {
    const { iris, registerCapabilities } = await import('@syrin/iris');
    iris.connect({ session: 'my-app' });
    registerCapabilities({ testids: [], signals: [], stores: [] });
  }
</script>
```

---

## Step 4 — Validate the connection

Tell the user: "Start your dev server (`<their command>`), then open the app in the browser."

Once they confirm, call:

```
iris_sessions()
```

You should see something like:

```jsonc
{
  "sessions": [
    {
      "sessionId": "my-app",
      "url": "http://localhost:3000/",
      "title": "…",
      "adapters": ["react"],
      "hasCapabilities": false,
    },
  ],
}
```

If `sessions` is empty, run through the checklist in the Troubleshooting section below.

If connected, call `iris_snapshot({ mode: "interactive" })` and show the user what the agent
can see — this is the "magic moment" that makes Iris feel real.

---

## Step 5 — Register capabilities (high-leverage, do this now)

This is the single highest-value addition. A registered surface means any future agent session
starts knowing exactly what to drive — without reading source files.

**Add `data-testid` to the most important interactive elements.** Focus on:

- Primary CTA buttons (submit, confirm, create)
- Navigation links or tabs
- Key form inputs
- The main content regions (lists, tables, dashboards)

Example (React JSX, same idea in Vue/Svelte/HTML):

```tsx
<button data-testid="create-order">Create order</button>
<input  data-testid="order-amount" … />
<nav    data-testid="main-nav">…</nav>
```

**Add `iris.signal()` at the commit points that matter.** The DOM can't show a save
committed, a webhook arriving, an async generation finishing, or an edit applied. A signal
makes those facts assertable:

```ts
import { iris } from '@syrin/iris';

// In your store / action / API hook — wherever the thing actually happens:
onOrderSaved((order) => iris.signal('order:saved', { id: order.id, total: order.total }));
onCartUpdated(() => iris.signal('cart:updated'));
```

> **Prefer injecting an emitter over importing `iris` in components.** Use
> `createIrisEmitter()` to keep `@syrin/iris` out of the production bundle:
>
> ```ts
> // app-wide emitter (injected, not imported in every component)
> import { createIrisEmitter } from '@syrin/iris';
> export const emit = createIrisEmitter();
>
> // in components / stores:
> emit.signal('order:saved', { id }); // safe no-op until iris.connect() runs
> ```

**Register stores** so the agent can read live state without you broadcasting it:

```ts
import { registerStore } from '@syrin/iris';
// Zustand:
registerStore('cart', () => useCartStore.getState());
// Pinia:
registerStore('cart', () => cartStore.$state);
// Redux:
registerStore('app', () => store.getState());
```

**Update `registerCapabilities`** in your `iris-dev.ts` / `IrisDev` component to list
everything you just added:

```ts
registerCapabilities({
  testids: ['create-order', 'order-amount', 'main-nav'],
  signals: ['order:saved', 'cart:updated'],
  stores: ['cart'],
});
```

Then persist to disk so any future agent session can read it without a browser:

```
iris_contract_save()   // writes .iris/contract.json — commit this file
```

---

## Step 6 — Create your first flow (do this if the user wants automation)

Ask the user: "What's the single most important user journey in your app? For example:
'user logs in', 'user creates an order', 'user searches and finds a result'."

Once they describe it, record it by driving the golden path:

```
iris_record_start({ recordingName: "golden-path-name" })

// drive every step: iris_act, iris_act_sequence, iris_scroll_to, …
// assert at each milestone: iris_assert, iris_wait_for

iris_record_stop({ recordingName: "golden-path-name" })
iris_flow_save({ flowName: "golden-path-name" })
// → writes .iris/flows/golden-path-name.json  — commit this file
```

To replay it later (regression check):

```
iris_flow_replay({ flowName: "golden-path-name" })
// → { status: "ok" } or { status: "drift", … } with the exact anchor that missed
```

If a refactor renames a testid and replay drifts:

```
iris_flow_heal({ flowName: "golden-path-name", apply: true })
// → repairs the anchor on disk if it finds a confident nearest match
```

---

## Best practices (tell the user these or apply them yourself)

**Do:**

- Keep `iris.connect()` strictly behind a dev guard — never in production.
- Use `data-testid` on every element the agent drives regularly. Stable testids survive
  refactors; visible text and CSS selectors do not.
- Emit a signal at every "something important happened" moment that the DOM doesn't show.
- Register stores so the agent reads state directly instead of inferring it from the DOM.
- Pass `present: true` when pair-programming so the user can follow the agent's actions.
- Commit `.iris/contract.json` and `.iris/flows/` — they're small, human-readable JSON,
  and they let any agent (and CI) know the testable surface.
- Pass the `since` cursor from `iris_act` into `iris_assert`/`iris_observe` so stale
  buffered events can never fake a pass.

**Don't:**

- Import `@syrin/iris` in production components. Use `createIrisEmitter()` + injection.
- Use `iris_snapshot({ mode: "full" })` as the default perception step — it costs ~4k tokens
  on large pages. Use `iris_snapshot({ mode: "interactive" })` (~110 tokens) or
  `iris_query` (~28 tokens) to find what you need first.
- Rely on element refs (`e7`) across page navigations — re-query after any route change.
- Leave sessions running when done. Call `iris_end_session()` so the HUD clears.

**Token discipline (important for long sessions):**

```
iris_snapshot mode:"interactive"  →  ~110 tokens  ← use this, not "full"
iris_query one element            →   ~28 tokens
iris_observe after an act         →   ~39 tokens
iris_assert verdict               →   ~33 tokens
A full verify loop                →  ~100 tokens total

vs Playwright MCP per-step        → ~6,900 tokens
```

Use `iris_snapshot({ mode: "status" })` (~31 tokens) just to check the current route.
Use `iris_query` to find a specific element instead of snapshotting the whole page.

---

## Quick reference — tool cheat sheet

```
# Perceive
iris_sessions()                                       # list connected tabs
iris_snapshot({ mode: "interactive" })                # what's clickable/focusable
iris_query({ by: "testid", value: "my-btn" })         # find a specific element → ref
iris_inspect({ ref: "e7" })                           # box + component + file:line
iris_state({ store: "cart" })                         # live store state

# Act
iris_act({ ref: "e7", action: "click" })              # → { since }
iris_act({ ref: "e7", action: "fill", args: { value: "hello" } })
iris_act_sequence({ steps: [{ref,action}, …] })

# Observe & assert
iris_observe({ since, filters: ["net","signal"] })    # what happened after that act
iris_assert({ predicate: { kind:"signal", name:"order:saved" }, since, timeout_ms: 3000 })
iris_assert({ predicate: { kind:"net", urlContains:"/api/orders", status:201 }, since })
iris_wait_for({ predicate: { kind:"element", query:{by:"testid",testid:"success-banner"}, state:"visible" } })

# Flows
iris_record_start({ recordingName: "name" })
iris_record_stop({ recordingName: "name" })
iris_flow_save({ flowName: "name" })
iris_flow_replay({ flowName: "name" })
iris_flow_heal({ flowName: "name", apply: true })

# Cleanup
iris_end_session({ summary: "done" })
```

**Predicate kinds:** `element` · `signal` · `net` · `route` · `console` · `animation` ·
`allOf` · `anyOf` · `not`

---

## Troubleshooting

**`iris_sessions()` returns an empty list**

1. Is the app running? Start the dev server and open it in a browser tab.
2. Is `iris.connect()` executing? Add a temporary `console.log('iris connecting')` before
   it to confirm the code path runs.
3. Is the MCP server alive? In Claude Code, run `/mcp` — it should show `iris: connected`.
   If not, check `.mcp.json` exists in the project root and restart the agent.
4. Port mismatch? The bridge defaults to 4400. If you set `IRIS_PORT`, pass the same URL:
   `iris.connect({ url: 'ws://localhost:<port>/iris' })`.

**The tab connects but `adapters` is empty (no `"react"`)**

The React adapter (`install()`) was not called before `iris.connect()`. Make sure `install()`
runs first in your `iris-dev.ts`.

**`iris_inspect` returns no `source` (file:line)**

- React 18: `install()` needs to run — it hooks into React's dev `_debugSource`.
- React 19: add `@syrin/iris/babel` to your Vite config (Step 3).
- Next.js: add `@syrin/iris/next` → `withIris` to `next.config.mjs`.

**Actions dispatch but the app doesn't react (no DOM mutations, no network call)**

- The element might be occluded (`occluded: true` in the `iris_act` result). Another element
  is on top — dismiss the overlay first.
- The element might be outside the viewport. Use `iris_scroll_to` first.
- Check `effect.enabled` — a disabled button won't react to a click.

**Hover / drag / tooltips don't work**

Synthetic events cannot trigger `onMouseEnter`. For hover-gated UI you need a CDP-driven
browser:

1. Launch your browser with `--remote-debugging-port=9222`.
2. Add `"IRIS_CDP_URL": "http://localhost:9222"` to the server `env` in `.mcp.json`.
3. `iris_act` will report `inputMode: "real"` for pointer actions.

**Assertions are flaky on async UIs**

Always pass `since` (from `iris_act`) and `timeout_ms`. The `since` cursor scopes the check
to only post-action events so a stale buffer can't fake a pass:

```ts
const { since } = await iris_act({ ref, action: "click" });
await iris_assert({ predicate: …, since, timeout_ms: 3000 });
```

**Nothing in production / tree-shaking**

- `iris.connect()` must be inside a dev guard.
- Components importing `iris` directly will pull the bundle into production. Use
  `createIrisEmitter()` + injection instead (the emitter interface has no `@syrin/iris` dep).

---

## What to tell the user when you're done

Once the connection is validated and capabilities are registered, tell the user:

> "Iris is set up. I can now see your running app, click through it, watch every network call
> and DOM change, and assert real outcomes — without screenshots.
>
> A few things to know:
>
> - To watch me work in the browser, add `present: true` to `iris.connect()`.
> - Add `data-testid` to anything you want me to interact with reliably.
> - Call `iris.signal('event-name', data)` wherever something important happens off-DOM.
> - `.iris/contract.json` and `.iris/flows/` are committed — any agent (or CI) can read them.
>
> Next time you ask me to build or verify something, I'll use Iris automatically."
