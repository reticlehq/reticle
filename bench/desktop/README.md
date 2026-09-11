# Desktop benchmark — Reticle MCP vs Playwright MCP

One task, one app, both tools attached to the **same** running Electron process at the same time.

> Archive a todo, then verify the archive actually worked.

The app's Archive button removes the row and writes "archived" — and its IPC call **always fails**. So the axis that matters is not speed. It is whether the tool can tell the truth.

## Running it

```bash
npx @playwright/mcp@latest --help >/dev/null      # or: npm i --no-save @playwright/mcp
npx @reticlehq/server serve                       # daemon on :4400

# Electron must expose CDP, or Playwright MCP cannot attach at all
cd apps/electron-smoke && RETICLE_DEMO_FILE=1 pnpm exec electron . --remote-debugging-port=9222

node bench/desktop/desktop-mcp-bench.mjs
```

Each contender is run against a **freshly reloaded app**. Without that reset the numbers are meaningless: the Reticle passes archive the todos, Playwright then arrives at an empty list, never finds an Archive button, and its "the row is gone" check passes for a reason that has nothing to do with the click — a false green in the benchmark itself.

## Result (macOS, Electron 34, `@playwright/mcp` 0.0.78)

| tool | calls | ~tokens | ms | verdict |
| --- | --- | --- | --- | --- |
| reticle | 3 | 981 | 1375 | **CAUGHT** — `ui-advanced-request-failed: IPC ipc://todos:archive → 500` |
| reticle (lean) | 3 | **350** | 1364 | **CAUGHT** — `ipc://todos:archive → 500` |
| playwright-mcp | 3 | 1069 | **980** | blind to the failure — no network/IPC in any output |
| pw-mcp → Tauri | 1 | 42 | 181 | **cannot attach** — WKWebView exposes no CDP endpoint |

`~tokens` is bytes/4 of tool OUTPUT — what the agent's context window actually pays for.

**Run-to-run variance.** Two runs a session apart gave lean-Reticle 277 and 350 tokens, and Playwright 992 and 1069, so the ratio moves between roughly 3.1× and 3.6×. Output size depends on how many todos are on screen when the snapshot is taken, which the preceding steps change. Treat the order of magnitude as the result and not the third digit; the verdict column was identical in both.

### What this does and does not show

**Playwright MCP is faster.** 980ms vs 1364ms, and that is a real advantage. Most of Reticle's extra time is the deliberate settle wait after the click.

**It is also structurally blind here.** The claim is not "Playwright guessed wrong" — it is that nothing in its output _mentions_ the failed call, so no verification strategy built on that output can distinguish "archived" from "the archive failed and the UI lied". Its channel is the accessibility tree; IPC is not in it. The benchmark asserts this directly by searching everything Playwright returned for any trace of the failure, rather than by grading its answer.

**The lean Reticle path is 3.6× cheaper** than Playwright MCP (277 vs 992 tokens) _and_ correct. That is the part worth internalising: this is not a cost-for-accuracy trade. Asking one targeted question (`reticle_network { status: 500 }`, 109 bytes) beats reading two accessibility snapshots (3845 bytes), because a snapshot re-describes the whole page to answer a question about one call.

**Tauri is not a contest.** Playwright cannot attach to a WKWebView at all. There is no CDP endpoint to connect to, so the row is a capability statement, not a score.

### Caveats, stated plainly

- One task, one app, one machine. This is a demonstration of a failure _class_, not a suite average.
- The app is ours and the bug is planted. That is deliberate — the false green has to be known in advance for "did you catch it?" to be gradeable — but it is not the same as finding a bug in the wild, and should not be reported as if it were.
- Playwright MCP is a general browser-automation tool being measured on a desktop-IPC task it was never designed for. On a plain web app with an HTTP backend it sees the network fine.
