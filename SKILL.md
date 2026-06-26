# Syrin Iris

Start by detecting which mode to run:

```bash
# Is Iris already set up in this project?
cat .iris.json 2>/dev/null || echo "NOT_FOUND"
```

- **`.iris.json` not found → run Setup (below)**
- **`.iris.json` found → run Test (further below)**

---

# SETUP MODE

> Run this once per project. Writes config files, installs the SDK, and validates the connection. After setup, every subsequent `/iris` goes straight to Test mode.

## Step 0 — Ask these questions before doing anything

Ask ALL of them in a single message. Do not start installing until you have the answers.

**Before asking Q5**, run the detection commands below to pre-fill a suggestion — but always confirm with the user, because they may plan to use a tool that isn't installed yet.

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

3. What port does your dev server run on?
   (e.g. 3000, 5173, 8080 — the port number only, not the full URL)
   Syrin Iris attaches to your running server — you keep running `npm run dev` yourself.
   Syrin Iris does NOT start or manage your dev server.

4. Do you already have data-testid attributes on your key elements?
   (If yes, Syrin Iris reuses them. If no, we'll add a handful to the most important elements.)

5. Which AI coding tool(s) will you use this project with?
   (I detected: <list from detection above, or "none found">)

   a) Claude Code   b) OpenCode   c) Codex CLI
   d) Cursor        e) Windsurf   f) VS Code + GitHub Copilot   g) Zed
   h) Multiple — list them

   Save as IRIS_HARNESSES.
```

---

## Step 1 — Configure the MCP server

> **Fast path (Claude Code + Vite or Next.js):** Run `npx @syrin/iris init --port <Q3 answer>`. This handles Steps 1–4 automatically for Claude Code and Cursor. Jump to Step 4 to validate.

> For all other harnesses or manual control, follow the steps below. There is no single MCP config file all tools share. Each harness has its own file and schema. Write only the ones in `IRIS_HARNESSES`.

| Tool        | File                                  | Root key             | Command format               | `type` needed?     |
| ----------- | ------------------------------------- | -------------------- | ---------------------------- | ------------------ |
| Claude Code | `~/.claude/claude_mcp_config.json`    | `mcpServers`         | `"command"` + `"args"` split | no                 |
| OpenCode    | `opencode.json`                       | `mcp`                | `"command"` flat array       | `"local"` required |
| Codex CLI   | `.codex/config.toml`                  | `[mcp_servers.iris]` | TOML `command` + `args`      | no                 |
| Cursor      | `.cursor/mcp.json`                    | `mcpServers`         | `"command"` + `"args"` split | no                 |
| Windsurf    | `~/.codeium/windsurf/mcp_config.json` | `mcpServers`         | `"command"` + `"args"` split | no                 |
| VS Code     | `.vscode/mcp.json`                    | `"servers"`          | `"command"` + `"args"` split | no                 |
| Zed         | `~/.config/zed/settings.json`         | `context_servers`    | `"command"` + `"args"` split | no                 |

**Claude Code** (user-level, default)

Register once globally so Syrin Iris is available in every project:

```bash
claude mcp add iris -s user -- npx @syrin/iris mcp
```

Confirm with `claude mcp list` — `iris` should appear. Tell user to reload Claude Code (`/mcp` to refresh).

**If the `claude` CLI is unavailable**, fall back to writing `~/.claude/claude_mcp_config.json` (create if missing, merge `"iris"` if it exists):

```jsonc
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp"],
    },
  },
}
```

Only write to `.mcp.json` (project root) if the user explicitly asks for project-level registration.

**OpenCode — `opencode.json`** (`type:"local"` required; command is one flat array, no `args`)

```jsonc
{
  "mcp": {
    "iris": {
      "type": "local",
      "command": ["npx", "@syrin/iris", "mcp"],
    },
  },
}
```

Verify with `opencode mcp list`.

**Codex CLI — `.codex/config.toml`** (TOML, not JSON)

```toml
[mcp_servers.iris]
command = "npx"
args    = ["@syrin/iris", "mcp"]
```

**Cursor — `.cursor/mcp.json`** (same schema as Claude Code, different path)

```jsonc
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@syrin/iris", "mcp"],
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
      "args": ["@syrin/iris", "mcp"],
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
      "args": ["@syrin/iris", "mcp"],
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
      "args": ["@syrin/iris", "mcp"],
    },
  },
}
```

---

## Step 1b — Stop hook (Claude Code only — skip unless asked)

**Do not add this hook by default.** Killing the daemon after every turn is the most common cause of the "Failed to reconnect to iris: -32000" error: the daemon is stopped, Claude Code immediately reconnects, and the new daemon sometimes takes longer than expected to boot — the proxy times out and exits with code 1, which Claude Code reports as -32000.

Iris doesn't need the hook. `iris_yield` (mandatory — see Rules) signals turn end in-band, and the server flips the panel to "waiting" automatically if the agent goes quiet.

Only add this if the user explicitly asks for the daemon to stop between turns:

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

> **Mental model:** The user keeps running their dev server (`npm run dev`) themselves. Syrin Iris embeds a tiny SDK in the app that connects to a local bridge daemon. The agent talks to the daemon over MCP — no Chromium is downloaded or needed for standard agent workflows. Playwright is only required if you explicitly use `--drive` mode.

```bash
npm install --save-dev @syrin/iris    # swap npm for pnpm/yarn/bun per Q2
```

---

## Step 3 — Wire up the SDK

**Vite + React**

Add the Iris plugin to `vite.config.ts` — it auto-injects `iris.connect()` in dev builds:

```ts
// vite.config.ts
import { iris } from '@syrin/iris/vite';

export default defineConfig({
  plugins: [react(), iris()], // iris() is dev-only, dropped from vite build
});
```

Then describe your app's testable surface so the agent knows what to drive (fill in your real values):

```ts
// src/iris-dev.ts  (import in main.tsx inside import.meta.env.DEV check)
import { registerCapabilities } from '@syrin/iris';
if (import.meta.env.DEV) {
  registerCapabilities({
    testids: [], // your data-testid values, e.g. ['login-btn', 'submit-form']
    signals: [], // your iris.signal() names, e.g. ['auth:login']
    stores: [], // your registerStore() names
  });
}
```

**Next.js (App Router)**

Create `app/iris-dev.tsx`:

```ts
'use client';
import { useEffect } from 'react';
export function IrisDev() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    void import('@syrin/iris').then(({ iris, install, registerCapabilities }) => {
      install();
      iris.connect();
      registerCapabilities({
        testids: [], // your data-testid values
        signals: [], // your iris.signal() names
        stores: [], // your registerStore() names
      });
    });
  }, []);
  return null;
}
```

Mount it in `app/layout.tsx` (dev-only):

```tsx
import { IrisDev } from './iris-dev';
// inside <body>:
{
  process.env.NODE_ENV === 'development' ? <IrisDev /> : null;
}
```

Add `@syrin/iris/next` → `withIris` to `next.config.mjs` for source mapping:

```ts
import { withIris } from '@syrin/iris/next';
export default withIris(nextConfig);
```

**Other frameworks** — call `iris.connect()` and `install()` inside a dev guard. Vanilla / HTML: use a dynamic `import('@syrin/iris')` inside `if (location.hostname === 'localhost')`.

---

## Step 4 — Save config and validate

If you used `iris init` in Step 1, `.iris.json` was already written. Verify with:

```bash
cat .iris.json
```

If setting up manually, write `.iris.json` to the project root (commit this — `iris mcp` reads it to pick the right port):

```jsonc
{
  "framework": "vite-react",
  "port": 5173,
}
```

Fill in framework from Q1, port from Q3. Omit `port` if using the default (4400). Each project should have its own port so multiple apps can run Syrin Iris simultaneously without conflicts.

Tell the user: **"Run `npm run dev` (your normal dev server) and open the app in your browser."**

Once they confirm the app is open, call `iris_wait_ready()` then `iris_sessions()`. You should see a session whose URL matches the app's localhost address. If no session appears after a few seconds, the SDK is not yet wired — confirm Step 3 was applied and the page has been refreshed.

When a session is confirmed, tell the user:

> "Syrin Iris is set up. Type `/iris` anytime to verify the app after a change."

**Setup complete — stop here. Do not proceed to Test mode.**

---

---

# TEST MODE

> Runs automatically when `.iris.json` exists. Connects to the running app, exercises flows, asserts outcomes, and reports what passed and what broke.

## Phase 1 — Connect

Just ran `iris init` or started the dev server? Call **`iris_wait_ready()`** first — it blocks until the app's SDK connects (returns instantly if it already has), so your first real call doesn't lose the race with the WebSocket. Then call `iris_sessions()`. Three possible states:

**A. One session → proceed.**

**B. No sessions:** Tell the user:

> "No app connected. Run your dev server (`npm run dev`) and open the app in your browser, then try `/iris` again. Syrin Iris never starts the dev server for you — that's your job." Stop here.

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

For flows worth re-checking forever — the actual test suite — record them, then re-verify the whole set in ONE deterministic call (no LLM per flow, so it's ~hundreds of tokens, not a full re-drive):

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
   On a failure the envelope tells you exactly what changed, the `file:line`, and the fix (e.g. "rebind to 'new-deploy'") — act on `nextAction` directly. A single flow: `iris_flow_replay({ flowName })`.

### Catch the bugs a DOM/snapshot tool misses

- **UI-vs-state desync** (the UI shows one value, the store holds another — e.g. a count that didn't refresh): read the truth with `iris_state({ sessionId, store, path })` and compare it to what's displayed. A snapshot can't — the source of truth isn't in the DOM.
- **Present-but-unusable / off-theme controls**: `iris_inspect` returns `occluded` (covered by an overlay), `styles.cursor`/`opacity`, `box` (0×0), and `theme.offTheme` (color off the design-token palette). A snapshot says the element is "there"; inspect says whether a user can actually use it.

### Consume the human's bug reports (`iris_review`)

The dev can click **"Flag a bug"** in the running app, point at an element, and type what's wrong. Each flag becomes a **mark** you drain with `iris_review`:

```
iris_review({ sessionId })
→ { marks: [{ id: "m1", note: "this button is misaligned", label: "button \"Pay\"",
              source: { file: "src/Checkout.tsx", line: 42 },
              fix: "Open src/Checkout.tsx:42 and fix: this button is misaligned. Then iris_review { resolve: \"m1\" }" }],
    pendingCount: 1 }
```

Check it at the start of a session and whenever the human may have flagged something. Open the `source` file:line, apply the fix the `note` asks for, verify, then `iris_review({ resolve: "m1" })`. Reading never consumes a mark, so you can list → fix → verify → resolve.

---

## Phase 5 — Report

Always refer to the tool as **Syrin Iris** in reports, summaries, and messages to the user.

```
## Syrin Iris — <route or feature>

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

If something failed, call `iris_inspect({ sessionId, ref })` on the failing element to get the `file:line`, and include it in the report.

---

## Rules (always apply in Test mode)

- **Always close the session when you stop driving.** The human may be watching the browser, so the panel must reflect your real state — never leave it reading "live" when you've stopped. The moment you finish a turn or need the human, call `iris_yield({ mode: "waiting" })`, or `iris_yield({ mode: "ask", note: "<your question>" })` when you're blocked on them. Call `iris_end_session()` only when the whole task is done. The session revives automatically on your next action, so this is cheap and safe to do every time. (A server-side idle fallback flips the panel to "waiting" if you forget, but signal it yourself — it's immediate and it can say _why_.)
- Always pass `since` in `iris_assert` — scopes to post-action events, prevents stale buffer fakes.
- Always assert `{ kind: "console", level: "error", absent: true }` — silent errors are the most common thing agents miss.
- Batch net + element + signal + console into one `allOf` — don't call `iris_assert` four times.
- Never assert on pixels — use predicates, not `iris_screenshot` (screenshots are for genuinely visual checks only).
- If the session disconnects mid-test (navigation creates a new session ID) — call `iris_sessions()` again and continue.

---

## Troubleshooting

### Multiple projects / port conflicts

Each project should have its own port in `.iris.json`. When `iris mcp` starts, it reads `.iris.json` in the current working directory and uses that project's port — so agents in different project directories automatically connect to different daemons.

If two projects share the same port, start the second on a different port:

```bash
npx @syrin/iris stop --port 4400   # stop the other project's daemon if needed
# Then ensure .iris.json in this project has a unique "port" field
```

Use `npx @syrin/iris status` to see which daemons are running and which sessions are connected.

### No Chromium / Playwright needed for standard use

Syrin Iris does NOT download Chromium for normal agent workflows. The browser SDK runs inside the user's own browser — the agent sees the DOM, network, console, and state through the WebSocket bridge. Playwright is only installed if you explicitly call `iris serve --drive <url>` or `iris verify`, which launch an autonomous browser for unattended automation.

To attach to a browser the user already has open (zero download, zero extra process):

```bash
# Start Chrome with remote debugging enabled (user does this once):
# Mac: /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222
# Then set IRIS_CDP_URL when starting the daemon:
IRIS_CDP_URL=http://localhost:9222 npx @syrin/iris mcp
```

This connects Syrin Iris to the existing Chrome — native clicks and screenshots work without Playwright.

### "Failed to reconnect to iris: -32000"

This means the `iris mcp` proxy process exited and Claude Code couldn't restart it cleanly. -32000 is the JSON-RPC code for a server-side error; here it means the proxy exited with code 1 before the MCP handshake completed.

**Check version first — stale npx cache is the most common silent culprit.** `npx` caches packages locally and may keep running an old version of `@syrin/iris` even after a new one is published. An older daemon speaking a different protocol than the new proxy (or vice-versa) causes the proxy to exit immediately and Claude Code to report -32000. Always clear the cache and force-resolve the latest version before investigating anything else:

```bash
npx --yes @syrin/iris@latest version   # force-resolves latest and prints version
npx @syrin/iris stop                   # stop any daemon running the old version
```

Then reload Claude Code (`/mcp`) so the new version is picked up on next connection.

**Second common cause: the Stop hook is killing the daemon between turns.** If `~/.claude/settings.json` has a Stop hook running `iris stop --quiet`, remove it. The daemon must stay alive across turns — killing it forces a cold-boot spawn on every reconnect, and if that spawn takes longer than 10 seconds (cold npx cache, slow disk, first install), the proxy times out and exits with code 1. See Step 1b above.

**Fix (in order):**

1. **Force the latest version and clear the stale daemon:**

   ```bash
   npx --yes @syrin/iris@latest version
   npx @syrin/iris stop
   ```

   Reload Claude Code. If -32000 is gone, done.

2. **Check for the Stop hook:** `cat ~/.claude/settings.json | grep iris` If present, delete that hook entry, then repeat step 1.

3. **If -32000 persists**, the daemon may be crashing on startup. Check the log: `cat ~/.iris/daemon-4400.log | tail -30` Look for `iris_daemon_start_failed` or `iris_mcp_proxy_error`. If the port is taken by another process: `lsof -i :4400` to identify it, then kill it and retry.

4. **Confirm the MCP config is user-level** (not project-level) and has no pinned version:

   ```bash
   cat ~/.claude/claude_mcp_config.json
   # Should contain: {"mcpServers": {"iris": {"command": "npx", "args": ["@syrin/iris", "mcp"]}}}
   ```

   If the project has a `.mcp.json` or `.claude/mcp.json` that overrides the user-level config with pinned args (e.g., `["@syrin/iris@0.x.y", "mcp"]`), rename it out of the way and re-register:

   ```bash
   claude mcp add iris -s user -- npx @syrin/iris mcp
   ```

**Tell the user what you found** so they can confirm which fix applies.
