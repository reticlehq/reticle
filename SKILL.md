# Iris

Start by detecting which mode to run:

```bash
# Is Iris already set up in this project?
cat .iris.json 2>/dev/null || echo "NOT_FOUND"
```

- **`.iris.json` not found → run Setup (below)**
- **`.iris.json` found → run Test (further below)**

---

# SETUP MODE

> Run this once per project. Writes config files, installs the SDK, and validates the
> connection. After setup, every subsequent `/iris` goes straight to Test mode.

## Step 0 — Ask these questions before doing anything

Ask ALL of them in a single message. Do not start installing until you have the answers.

**Before asking Q7**, run the detection commands below to pre-fill a suggestion — but always
confirm with the user, because they may plan to use a tool that isn't installed yet.

```bash
which claude    2>/dev/null && echo "claude-code"
which opencode  2>/dev/null && echo "opencode"
which codex     2>/dev/null && echo "codex"
ls ~/.cursor/                             2>/dev/null && echo "cursor"
ls ~/.codeium/windsurf/                   2>/dev/null && echo "windsurf"
ls .vscode/                               2>/dev/null && echo "vscode"
which zed       2>/dev/null && echo "zed"
```

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

3. What port does your dev server normally run on?
   (e.g. 3000, 5173, 8080 — just the number, not the full URL)

4. Do you already have data-testid attributes on your key elements?
   (If yes, Iris reuses them. If no, we'll add a handful to the most important elements.)

5. How do you want to use Iris?
   a) Quick spot-check — verify a specific thing the agent just built.
   b) Pair programming — present mode on, watch the agent work in the browser.
   c) Full automation — record flows, replay in CI, catch regressions.
   d) All of the above.

6. Do you want to see the browser while the agent tests?
   a) Yes — show me a real browser window (headed mode).
   b) No — run silently in the background (headless, default).

   Save as IRIS_HEADED (true / false).

7. Which AI coding tool(s) will you use this project with?
   (I detected: <list from detection above, or "none found">)

   a) Claude Code   b) OpenCode   c) Codex CLI
   d) Cursor        e) Windsurf   f) VS Code + GitHub Copilot   g) Zed
   h) Multiple — list them

   Save as IRIS_HARNESSES.
```

---

## Step 0b — Pick a dedicated Iris testing port

Iris runs its own dev server instance so it never collides with the user's browser session.

**Default: port 4310.** Check if it's free:

```bash
lsof -ti :4310 2>/dev/null | head -1
```

No output = free. If busy:

```bash
lsof -i :4310 2>/dev/null | head -5
```

Ask the user: "Port 4310 is in use by `<process>`. Use 4311 instead, or kill that process?"
**Never silently pick an occupied port.** Save the confirmed port as `IRIS_PORT`.

Also check the user's regular dev port (from Q3) isn't occupied by something unexpected.

---

## Step 1 — Configure the MCP server

> There is no single MCP config file all tools share. Each harness has its own file and
> schema. Write only the ones in `IRIS_HARNESSES`.

| Tool        | File                                  | Root key             | Command format               | `type` needed?     |
| ----------- | ------------------------------------- | -------------------- | ---------------------------- | ------------------ |
| Claude Code | `.mcp.json`                           | `mcpServers`         | `"command"` + `"args"` split | no                 |
| OpenCode    | `opencode.json`                       | `mcp`                | `"command"` flat array       | `"local"` required |
| Codex CLI   | `.codex/config.toml`                  | `[mcp_servers.iris]` | TOML `command` + `args`      | no                 |
| Cursor      | `.cursor/mcp.json`                    | `mcpServers`         | `"command"` + `"args"` split | no                 |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`         | `"command"` + `"args"` split | no                 |
| VS Code     | `.vscode/mcp.json`                    | `"servers"`          | `"command"` + `"args"` split | no                 |
| Zed         | `~/.config/zed/settings.json`         | `context_servers`    | `"command"` + `"args"` split | no                 |

**Claude Code — `.mcp.json`**

```jsonc
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

Headed: append `"--headed"` to args. Tell user to reload Claude Code (`/mcp` to refresh).

**OpenCode — `opencode.json`** (`type:"local"` required; command is one flat array, no `args`)

```jsonc
{
  "mcp": {
    "iris": {
      "type": "local",
      "command": ["npx", "@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

Verify with `opencode mcp list`.

**Codex CLI — `.codex/config.toml`** (TOML, not JSON)

```toml
[mcp_servers.iris]
command = "npx"
args    = ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"]
```

**Cursor — `.cursor/mcp.json`** (same schema as Claude Code, different path)

```jsonc
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

**Windsurf — `~/.codeium/windsurf/mcp_config.json`** (global; create if missing)

```jsonc
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

**VS Code — `.vscode/mcp.json`** (`"servers"` not `"mcpServers"` — most common mistake)

```jsonc
{
  "servers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

MCP tools only appear in Copilot **Agent mode**.

**Zed — `~/.config/zed/settings.json`** (`context_servers` not `mcpServers`)

```jsonc
{
  "context_servers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp", "--drive", "http://localhost:4310"],
    },
  },
}
```

Replace `4310` with `IRIS_PORT` in all configs above.

---

## Step 1b — Register the stop hook (Claude Code only, optional backstop)

Iris is agent-independent: the agent signals its state in-band with `iris_yield` (mandatory — see
Rules), and the server flips the panel to "waiting" on its own if the agent goes quiet. This Claude
Code "Stop" hook is an extra belt-and-braces backstop that ends the daemon when the turn ends — skip
it if you prefer to rely on `iris_yield` + the idle fallback alone.

Write or merge into `.claude/settings.json`:

```jsonc
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "npx @syrin/iris stop --quiet" }],
      },
    ],
  },
}
```

---

## Step 2 — Install the SDK

```bash
npm install --save-dev @syrin/iris    # swap npm for pnpm/yarn/bun per Q2
```

---

## Step 3 — Wire up the SDK

Add to your app's dev entry point (inside a `DEV` guard — never runs in production):

**Vite + React**

```ts
// src/iris-dev.ts  (import in main.tsx inside import.meta.env.DEV check)
import { install } from '@syrin/iris/react';
import { iris, registerCapabilities } from '@syrin/iris';
if (import.meta.env.DEV) {
  install();
  iris.connect({ session: 'my-app' });
  registerCapabilities({ testids: [], signals: [], stores: [] });
}
```

**Next.js (App Router)**

```ts
// app/iris-dev.tsx  (import in layout.tsx inside a 'use client' + dev check)
'use client';
import { useEffect } from 'react';
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    import('@syrin/iris').then(({ iris, registerCapabilities }) => {
      import('@syrin/iris/react').then(({ install }) => {
        install();
        iris.connect({ session: 'my-app' });
        registerCapabilities({ testids: [], signals: [], stores: [] });
      });
    });
  }, []);
  return null;
}
```

Add `@syrin/iris/next` → `withIris` to `next.config.mjs` for source mapping.

**Other frameworks** — same pattern: import `iris` and call `iris.connect()` inside a dev
guard. Framework-specific adapters: Vue, Svelte adapters follow the same shape.

---

## Step 3b — Add `dev:iris` script

Add to `package.json` scripts so Iris has its own dev server on `IRIS_PORT`:

| Framework        | `dev:iris` value                  |
| ---------------- | --------------------------------- |
| Vite             | `"vite --port 4310"`              |
| Next.js          | `"next dev --port 4310"`          |
| Create React App | `"PORT=4310 react-scripts start"` |
| SvelteKit        | `"vite dev --port 4310"`          |
| Remix            | `"remix dev --port 4310"`         |

Replace `4310` with `IRIS_PORT`.

---

## Step 4 — Save config and validate

Write `.iris.json` to the project root (commit this):

```jsonc
{
  "port": 4310,
  "headed": false,
  "framework": "vite-react",
  "harnesses": ["claude-code"],
}
```

Fill in `IRIS_PORT`, `IRIS_HEADED`, framework from Q1, `IRIS_HARNESSES` from Q7.

Tell the user: **"Run `npm run dev:iris` to start the Iris testing server."**

Once they confirm it's running, call `iris_sessions()`. You should see a session at
`http://localhost:<IRIS_PORT>/`. If the URL shows a different port, another app connected
first — call `iris_end_session()` and navigate: `iris_navigate({ url: "http://localhost:<IRIS_PORT>" })`.

When a session is confirmed, tell the user:

> "Iris is set up. Type `/iris` anytime to verify the app after a change."

**Setup complete — stop here. Do not proceed to Test mode.**

---

---

# TEST MODE

> Runs automatically when `.iris.json` exists. Connects to the running app, exercises
> flows, asserts outcomes, and reports what passed and what broke.

## Phase 1 — Connect

Just ran `iris init` or started the dev server? Call **`iris_wait_ready()`** first — it blocks until
the app's SDK connects (returns instantly if it already has), so your first real call doesn't lose the
race with the WebSocket. Then call `iris_sessions()`. Three possible states:

**A. One session → proceed.**

**B. No sessions:**
Read `IRIS_PORT` from `.iris.json`. Tell the user:

> "No app connected. Run `npm run dev:iris` first, then try `/iris` again."
> Stop here.

**C. Multiple sessions — ask:**

> "I see [N] sessions connected: [list sessionId + url]. Which should I test?"

Pin `sessionId` for every subsequent call.

---

## Phase 2 — Orient

Call these in parallel:

```
iris_snapshot({ sessionId, maxDepth: 3 })
iris_capabilities({ sessionId })
iris_network({ sessionId, limit: 10 })
iris_console({ sessionId, limit: 20 })
```

Build a mental model:

- **Route/screen:** where is the app right now?
- **Testids:** what interactive elements are registered?
- **Signals:** what domain events does the app emit?
- **Console state:** any errors already present before touching anything?

Pre-existing console errors → call them out immediately before testing.

---

## Phase 3 — Decide what to test

Check what changed: `git diff HEAD --stat 2>/dev/null | head -20`

Then pick a mode:

| Context                                    | Mode                                             |
| ------------------------------------------ | ------------------------------------------------ |
| User says "test X" or names a flow         | **Targeted** — focus on that feature             |
| User says "everything" or "smoke test"     | **Smoke** — exercise every registered testid     |
| Recent git diff shows a specific component | **Targeted** — that component and adjacent flows |
| No clear signal                            | **Smoke**                                        |

---

## Phase 4 — Run the tests

### Targeted

1. Navigate if needed: `iris_navigate({ sessionId, url })`
2. Snapshot to confirm correct state
3. Act on controls using testids:
   ```
   iris_act({ sessionId, ref, action: "click" })
   ```
4. Assert — always use `since` from the act result:
   ```
   iris_assert({ sessionId, since, timeout_ms: 5000, predicate: { allOf: [
     { kind: "net",     method: "POST", urlContains: "/api/...", status: 200 },
     { kind: "element", query: { role: "...", name: "..." }, state: "visible" },
     { kind: "signal",  name: "..." },
     { kind: "console", level: "error", absent: true }
   ]}})
   ```
5. Record: ✅ pass / ❌ fail / ⚠️ partial

### Smoke

Walk every testid in `capabilities.testids`. For each one that is visible and interactable:

```
iris_query({ sessionId, by: "testid", value: testid })
→ iris_act({ sessionId, ref, action: "click" })
→ iris_assert({ since, predicate: { kind: "console", level: "error", absent: true } })
```

Flag anything that throws a console error or triggers a `status >= 400` network call.

### Regression suite (record once, re-verify on every change)

For flows worth re-checking forever — the actual test suite — record them, then re-verify the whole
set in ONE deterministic call (no LLM per flow, so it's ~hundreds of tokens, not a full re-drive):

1. Record + assert the business outcome (not just clicks):
   ```
   iris_record_start({ recordingName: "ship-deploy" })
   → drive the flow with iris_act
   → iris_annotate({ flow: "ship-deploy", kind: "intent", text: "ship a deploy to production" })
   → iris_annotate({ flow: "ship-deploy", kind: "success-state", signal: "deploy:shipped" })
   → iris_record_stop({ recordingName: "ship-deploy" }) → iris_flow_save({ flowName: "ship-deploy" })
   ```
2. After any change, re-verify EVERY saved flow at once:
   ```
   iris_flow_verify({ sessionId })
   → { status: "pass"|"fail", passed, failed, failures: [{ flow, verdict, whatChanged, whereInSource, nextAction }] }
   ```
   On a failure the envelope tells you exactly what changed, the `file:line`, and the fix
   (e.g. "rebind to 'new-deploy'") — act on `nextAction` directly. A single flow: `iris_flow_replay({ flowName })`.

### Catch the bugs a DOM/snapshot tool misses

- **UI-vs-state desync** (the UI shows one value, the store holds another — e.g. a count that didn't
  refresh): read the truth with `iris_state({ sessionId, store, path })` and compare it to what's
  displayed. A snapshot can't — the source of truth isn't in the DOM.
- **Present-but-unusable / off-theme controls**: `iris_inspect` returns `occluded` (covered by an
  overlay), `styles.cursor`/`opacity`, `box` (0×0), and `theme.offTheme` (color off the design-token
  palette). A snapshot says the element is "there"; inspect says whether a user can actually use it.

### Consume the human's bug reports (`iris_review`)

The dev can click **"Flag a bug"** in the running app, point at an element, and type what's wrong.
Each flag becomes a **mark** you drain with `iris_review`:

```
iris_review({ sessionId })
→ { marks: [{ id: "m1", note: "this button is misaligned", label: "button \"Pay\"",
              source: { file: "src/Checkout.tsx", line: 42 },
              fix: "Open src/Checkout.tsx:42 and fix: this button is misaligned. Then iris_review { resolve: \"m1\" }" }],
    pendingCount: 1 }
```

Check it at the start of a session and whenever the human may have flagged something. Open the
`source` file:line, apply the fix the `note` asks for, verify, then `iris_review({ resolve: "m1" })`.
Reading never consumes a mark, so you can list → fix → verify → resolve.

---

## Phase 5 — Report

```
## Iris — <route or feature>

**Result: ✅ PASS / ❌ FAIL / ⚠️ PARTIAL**

| Flow | Result | Evidence |
|---|---|---|
| Login → dashboard | ✅ | POST /api/login 200, route /dashboard |
| Click "Deploy"    | ❌ | POST /api/deploy 401 — missing auth header |
| Sidebar nav       | ✅ | 4 items, no console errors |

**Console errors:** none / <list>
**Failed requests:** none / <list>
**Fix at:** src/lib/api.ts:65   ← from iris_inspect on the failing element
```

If something failed, call `iris_inspect({ sessionId, ref })` on the failing element to get
the `file:line`, and include it in the report.

---

## Rules (always apply in Test mode)

- **Always close the session when you stop driving.** The human may be watching the browser, so the panel must reflect your real state — never leave it reading "live" when you've stopped. The moment you finish a turn or need the human, call `iris_yield({ mode: "waiting" })`, or `iris_yield({ mode: "ask", note: "<your question>" })` when you're blocked on them. Call `iris_end_session()` only when the whole task is done. The session revives automatically on your next action, so this is cheap and safe to do every time. (A server-side idle fallback flips the panel to "waiting" if you forget, but signal it yourself — it's immediate and it can say _why_.)
- Always pass `since` in `iris_assert` — scopes to post-action events, prevents stale buffer fakes.
- Always assert `{ kind: "console", level: "error", absent: true }` — silent errors are the most common thing agents miss.
- Batch net + element + signal + console into one `allOf` — don't call `iris_assert` four times.
- Never assert on pixels — use predicates, not `iris_screenshot` (screenshots are for genuinely visual checks only).
- If the session disconnects mid-test (navigation creates a new session ID) — call `iris_sessions()` again and continue.
