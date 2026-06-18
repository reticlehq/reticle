# Changelog

All notable changes to **`@syrin/iris`** are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.10] — 2026-06-18

### Added

- **Deterministic waiting — the `settled` predicate** (`packages/server`). A new predicate
  `{ kind: "settled", quietMs }` passes once network + structural-DOM activity has been quiet for
  `quietMs` (default 500ms); ambient `dom.text`/animation churn (count-ups, spinners) is ignored so
  an animated page can still settle. Usable in `iris_wait_for` and `iris_assert`, and composable inside
  `allOf` with the consequence you expect. Replaces fixed sleeps — the #1 cause of flaky agent tests.
- **`iris_act_and_wait` auto-settle** (`packages/server`). Omit `until` and the tool waits for the page
  to settle instead of requiring a predicate — "act, then wait for quiet" is now a single zero-config
  call, the documented alternative to a sleep.
- **`iris_query` token controls** (`packages/server`) — `limit` (cap returned descriptors; reports
  `total` + `truncated` so a trim is never silent) and `count_only` (return just the match count).
- **`iris_network` / `iris_console` token controls** (`packages/server`) — `limit` (keep the most
  recent N matches, reporting `total` + `droppedOldest`) and a `cost:{bytes,tokens}` hint, matching the
  other read tools so the agent can self-budget everywhere.
- **`iris_domain` `mustHold` per flow** (`packages/server`) — each flow now reports the success
  consequence that must hold for it (signal name / net URL), so an agent can answer "what are the
  critical flows and what must hold for each?" from the domain model alone.

### Changed

- **Self-healing now verifies the consequence before persisting** (`packages/server`). `iris_flow_heal`
  with `apply:true` re-replays the healed flow and re-asserts its success consequence; if a rebound
  locator resolves but the flow no longer satisfies its intent, the write is **refused**
  (`status:consequence_broken`, file untouched). It heals the locator, never the intent.

### Fixed

- **Browser observers fully restore patched globals on teardown** (`packages/browser`). The network,
  route, and console observers stored a bound copy and assigned it back on teardown, so `window.fetch`
  / `history.pushState` / `console.*` were never restored to their original identity. They now keep the
  true original for restore and a bound copy only for invocation.

## [0.5.0] — 2026-06-15

### Added

- **`iris mcp` — smart proxy with auto-start** (`packages/server`). Run `iris mcp --drive <url>` and you're
  done: it starts the daemon if one isn't running, waits for it to be ready, then bridges
  Claude Code's stdin/stdout to the daemon's SSE endpoint. Users no longer manage the daemon manually.
- **`iris mcp --drive <url>` / `iris serve --drive <url>`** — pass a URL and Iris launches its own
  Playwright browser at that URL, giving the agent full autonomous control without relying on the
  user's open browser tab.
- **`iris mcp --headed` / `--headed` flag** — opt in to a visible browser window so you can watch
  exactly what the agent is doing.
- **Three new update MCP tools** (`packages/server`):
  - `iris_version_info` — returns the installed version, execution kind (npx / global / local), and
    whether a newer version is available on npm.
  - `iris_apply_update` — upgrades Iris in place; requires `confirm: true` to actually run.
  - `iris_rollback` — downgrades to the previous version; requires `confirm: true`.
- **Presenter mode** (`packages/browser`, `packages/server`) — `iris.connect({ present: true })` mounts a
  dev-only HUD overlay that the agent can control: `iris_narrate` shows a caption, `iris_highlight`
  draws a ring around any element. The HUD is excluded from snapshots and tree-shaken in production.
- **Unified `SKILL.md` at repo root** — a single skill file auto-detects mode: setup wizard on first
  run (no `.iris.json`), live-app testing on every run after. Covers Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code, and Zed MCP config formats.
- **`.iris.json` project config** — written after first-run setup; persists `port`, `headed`,
  `framework`, and `harnesses` so subsequent runs need zero questions.
- **`dev:iris` script** in `apps/demo` — second Vite dev server on port 4310, isolated from the user's normal dev port.

### Fixed

- **All-throttled session auto-selection** (`packages/server`). When every connected tab is hidden
  (e.g. user is in VS Code with Chrome on another desktop), `SessionManager.resolve()` now picks the session with the freshest heartbeat instead of throwing `"multiple sessions connected"`.
- **Presenter HUD shows on bridge connect** — the overlay now mounts as soon as the SDK connects to the bridge, not only after the first `iris_narrate` call.
- **`iris_narrate` MCP schema validation** — relaxed the output schema so the tool no longer rejects responses from narration calls.
- **`iris_inspect` / `iris_clock` output schemas** — relaxed to pass through extra fields instead of stripping them, fixing spurious validation errors.

---

## [0.4.0] — 2026-06-11

First public release. Iris gives your coding agent **eyes** into your running web app and returns a
**verdict with evidence** instead of a screenshot.

### Added

- **The verify loop over MCP** — `look → act → observe → assert`. `iris_assert` evaluates a structured
  predicate against the live app and returns `{ pass, evidence, failureReason? }`, typically in ~100 tokens.
- **Six reaction types in one assert** — network calls, DOM changes, SPA navigation, console & errors
  (including "no errors during this flow"), animations, and app **signals**.
- **App signals** — `iris.signal()` lets your app emit the facts a screenshot can't see (the store
  committed, the webhook arrived); a bundled ESLint rule flags mutations that forgot to emit one.
- **Regression detection** — `iris_baseline_save` + `iris_diff` to catch silently removed elements or new
  console errors before they ship.
- **Source mapping** — DOM element → React component → `file:line`, on React 18/19 and Next.js (keeps SWC).
- **Autonomous crawler** (`iris_crawl`) that clicks every reachable control and classifies what breaks.
- **Declarative spec runner** (`@syrin/iris/test`) for signal-bound, headless verification specs.
- **The `iris` CLI** — bridge + MCP server, plus `iris drive` for a launched browser.
- **Single package, subpaths** — `@syrin/iris` ships the browser SDK (`.`), the server (`./server`), the
  spec runner (`./test`), source mapping (`./next`, `./babel`), and the lint rule (`./eslint`) — one install.

### Notes

- **Dev-only and localhost-only by default**; observers are additive and reversible, and the SDK is
  tree-shaken out of production. No telemetry.
- **Token efficiency** — a full verify loop is ~100 tokens vs ~7,300 for a full-tree snapshot (~73× on the
  common loop; ~1.8× full-tree-vs-full-tree). See [`docs/token-efficiency.md`](docs/token-efficiency.md)
  for the methodology and honest caveats.

[0.5.0]: https://github.com/syrin-labs/iris/releases/tag/v0.5.0
[0.4.0]: https://github.com/syrin-labs/iris/releases/tag/v0.4.0
