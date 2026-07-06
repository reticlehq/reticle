# Changelog

All notable changes to **`@reticlehq/core`** are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.1] — 2026-07-06

Bug-fix release. No breaking changes; drop-in over 1.3.0.

### Fixed

- **`reticle_sessions` now declares every field it returns** (`adapters`, `hasCapabilities`, `cleanup_suggestion`, `pendingMarks`, `review_suggestion`, and the input/lease fields). A strict MCP client validates tool output against the declared schema, so the previously-undeclared fields could trigger a hard validation error on the client side; they are now part of the contract. (`@reticlehq/server`)
- **The Reticle HUD no longer counts itself as an occluder** in `reticle_inspect` / `reticle_act` hit-tests. The dev-only presenter overlay could produce false-positive `occluded: true` readings for elements it visually covered; hit-testing now skips Reticle's own UI. (`@reticlehq/browser`)

### Changed

- HUD label capitalized to **Reticle** (was lowercase `reticle`). Display-only. (`@reticlehq/browser`)

## [1.3.0] — 2026-06-30

### Rebrand: Iris → Reticle (BREAKING)

The project is renamed from **Iris** to **Reticle**. This is a clean rename — no behavior changes — but every public identifier moves, so existing installs must migrate.

| What | Before | After |
| --- | --- | --- |
| Install | `iris` | `@reticlehq/core` |
| Scoped packages | `iris-*` | `@reticlehq/*` (e.g. `@reticlehq/protocol`, `@reticlehq/react`) |
| Subpath imports | `iris/server`, `/next`, `/babel`, `/vite`, `/eslint`, `/test` | `@reticlehq/core/server`, `…` |
| CLI binary | `iris` | `reticle` (`reticle init`, `reticle mcp`) |
| MCP server name | `iris` | `reticle` (update your `.mcp.json` / client config) |
| MCP tools | `iris_*` (e.g. `iris_observe`, `iris_assert`) | `reticle_*` (`reticle_observe`, `reticle_assert`) |
| Project config | `.iris.json` | `.reticle.json` |
| On-disk artifacts | `.iris/` (flows, runs, baselines, visual) | `.reticle/` |
| Env vars | `IRIS_*` (e.g. `IRIS_PORT`) | `RETICLE_*` (`RETICLE_PORT`) |
| DOM attributes | `data-iris-*` (e.g. `data-iris-source`) | `data-reticle-*` |
| Next.js wrapper | `withIris` | `withReticle` |

**Migrate:**

1. `npm rm iris && npm i -D @reticlehq/core` (swap any direct `iris-*` deps for `@reticlehq/*`).
2. Rename `.iris.json` → `.reticle.json` and the `.iris/` directory → `.reticle/` — recorded flows/baselines carry over unchanged.
3. Update your MCP client config: server key `iris` → `reticle`, command `npx @reticlehq/core mcp`, and any `IRIS_*` env vars → `RETICLE_*`. Agents calling tools by name move from `iris_*` to `reticle_*`.
4. Find/replace `withIris` → `withReticle` and any `iris` imports → `@reticlehq/core`.

## [1.2.0] — 2026-06-27

The multi-agent release. One Chromium now serves many agents at once — a leased browser pool gives each its own isolated context, and project-scoped session identity keeps several apps on one machine from cross-talking. Plus a polish pass: the benchmark suite runs unattended, CI stops going red on dependency advisories it can't control, the daemon-readiness window is tunable, and the docs + README are rewritten to lead with value. Measured: 16 flows across 8 contexts in 5.2s vs 35.4s serial — **6.78× faster**.

### Added

- **BrowserPool — one Chromium, N isolated leased contexts.** A fleet of agents shares one browser instead of launching one each. Leases carry a TTL + heartbeat with a reaper for orphans, `reticle_lease_acquire` waits for the tab to connect, and `reticle_sessions` shows `projectId` + `leased`.
- **Project-scoped session identity** (on by default). Sessions resolve against a stable build-stamped `projectId` (Next / HTML / `.reticle.json`, auto-stamped by the Vite plugin), so concurrent apps never steal each other's session.
- **SvelteKit support in `reticle init`** for projects the Vite plugin can't inject into.
- **Real-Chromium + multi-agent CI suites** — framework-connect tests (Vite/React, Next App Router, Remix, Astro), the browser-pool path, and single-page crash isolation.
- **`RETICLE_DAEMON_READY_TIMEOUT_MS`** — tune how long the MCP proxy waits for the daemon to become ready (default 10s) for slow machines / CI.

### Changed

- **Daemon resilience + per-page fault isolation.** One bad page can't sink the fleet: page faults are isolated, the pool enforces its cap under burst, aborted acquires clean up, and stale daemon pidfiles are reclaimed (no ghost ports).
- **Docs lead with value and read for everyone.** README rewritten — value-upfront hero, a "who you are → what you get" table (vibe coder / engineer / QA / founder), and a "How to use it" walkthrough. New [multi-agent testing guide](docs/multi-agent-testing.md); benchmark images + numbers refreshed; benchmark passes renamed to plain names (observation-cost / agent-loop / replay).
- **The benchmark self-boots.** `pnpm bench` now starts and tears down its own fixtures (demo + api) with env-tunable readiness (`BENCH_*`), so the suite runs unattended.
- **CI hardened against flaky reds.** The security-audit step is non-blocking (a new transitive advisory no longer fails an unrelated PR), the e2e job retries with cleanup, and pre-commit matches CI step order.

### Fixed

- **`@reticlehq/core/next` `withReticle` no longer crashes the host build** (a bundled `__require.resolve`).
- **`reticle init`** detects the monorepo package manager and gives correct guidance for non-Vite/Next apps (CRA / webpack).
- **Clearer edge errors** — an unopenable leased URL says why; the browser warns when the bridge is unreachable on first connect.
- **Skill & docs corrections** for the public integration path (MCP registration, `reticle init` flow, stale-`npx` cache as the main `-32000` cause).

### Removed

- **Unused public exports** — `ObserverType` / `UpdateStatus` (`@reticlehq/protocol`), `buildClock` (`@reticlehq/test`), and the test-only `RETICLE_VITE_PLUGIN_NAME` re-export from `@reticlehq/core/vite`. No real consumers.

## [1.0.0] — 2026-06-22

The 1.0 release. Reticle is stable, documented, and benchmarked end to end: every package is versioned `1.0.0` under the open-core license split, and the same verify loop that wins on a toy app stays the cheapest way to observe a real production dashboard.

The headline is the "lean responses" pass — same observations, fewer tokens. On the cross-tool detection benchmark Reticle's average observation cost drops 959 → 815 tokens with detection unchanged at 1.0 and zero false positives, lifting Verification Efficiency past the best external tool (12.27 vs 10.55) while remaining the only tool that catches every regression. Re-verifying a saved suite costs 47 tokens with no model and 0% flake, up to **2,574× cheaper** than re-driving it with an LLM.

### Added

- **Honest, reproducible benchmarks with a small-app vs real-app story.** A committed benchmark image set (re-run efficiency, the two-apps small-vs-real comparison, the per-tool cost on the real Reticle dashboard, and a capability matrix) rendered from a public source pipeline (`assets/benchmarks` + a shared design system), with the methodology written up in [`docs/benchmarks.md`](docs/benchmarks.md). On a real production dashboard Reticle observes a page for 1,023 tokens vs Chrome DevTools MCP's 1,357 and Playwright MCP's 2,193, and is the only tool that asserts success from the app's own signal.
- **Documentation set** — an [architecture overview](docs/architecture.md), the benchmarks explainer, an expanded [getting-started](docs/getting-started.md), and a Mintlify configuration so the docs publish as a site.
- **Open-source project hygiene** — `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and pull-request templates, plus contributor / stargazer / forker recognition in the README.

### Changed

- **`reticle_act` collapses a clean action to its consequence** — the effect block now omits fields at their uninformative default (an absent `dispatched`/`targetMatched`/`visible`/`enabled` means `true`; an absent `focusMoved`/`occludedBy` means `null`; an absent `occluded`/`scrolledIntoView`/ `valueChanged`/`defaultPrevented` means `false`), so a successful click returns just `domMutatedWithin` and any real signal still surfaces. No information is lost — absence always means the boring value.
- **MCP tool results serialize as compact JSON by default** — the agent-facing `text` content drops the two-space indentation (the typed `structuredContent` is unchanged), ~40% cheaper on the structured payloads that dominate. Set `RETICLE_ENCODING=pretty` for the previous indented form; `RETICLE_ENCODING=toon` remains the densest tabular encoding.
- **`reticle_act_and_wait` returns a reaction digest, not the full timeline** — `trace` is now `{ window_ms, summary }` (the counts that answer "what did the app do?") plus a `since` cursor; the full per-event timeline is one `reticle_observe { since }` away when the counts aren't enough. On a large DOM the dropped events array was the bulk of the loop cost — a verify loop on a 5,000-row grid falls from ~531 to ~279 tokens with the consequence still asserted from the `row:approved` signal.

### Fixed

- **Multiple apps on one machine no longer collide or orphan the daemon.** Several Next.js / React apps (or browser tabs) can run at once: the `@reticlehq/next` integration now defaults to a unique per-tab session id (`SESSION_AUTO`) instead of a shared constant, so two Next apps never silently evict each other. A bridge/daemon **port collision now fails fast with a clear error** instead of hanging forever and leaving an orphaned process — the `listen()` calls finally handle `EADDRINUSE`.
- **License files now carry a real copyright.** Filled the Apache-2.0 appendix in every SDK package license so no `[yyyy]` / `[name of copyright owner]` placeholders remain.

### Security

- **Daemon mode now enforces the documented auth contract.** `reticle serve` / the MCP daemon previously built its bridge without forwarding the pairing `token`, bind `host`, or origin allow-list, so `RETICLE_TOKEN` / `RETICLE_HOST` / `RETICLE_ALLOWED_ORIGINS` were silently ignored in daemon mode. They are now honored identically to the in-process path. (Residual risk was bounded — the daemon is loopback-pinned — but the advertised control is now actually enforced.)
- **Every security-critical environment variable is a single named constant** (`ReticleEnv` in `@reticlehq/protocol`). A typo in an inline `'RETICLE_TOKEN'` string could previously have disabled auth silently; the names now live in exactly one place.

## [0.9.0] — 2026-06-21

The "verify anywhere, ready for enterprises" release. One command verifies a running app from any pipeline — no MCP, no human — and enterprise features unlock with an offline license.

### Added

- **`reticle verify <url>`** — one-shot, non-MCP verification: drives the preview, replays the saved flows, prints a deterministic verdict, and exits non-zero on fail. The command CI and AI app-builder platforms call without speaking MCP — the same `ReticleVerificationRun` artifact the MCP and HTTP paths produce.
- **Drive a hosted preview** — for a non-localhost URL, Reticle re-invokes the page's `reticle.connect()` (allow-non-localhost + a one-shot pairing token) so a deployed preview pairs to the local bridge with no app redeploy; `reticle verify --storage-state <file>` replays a logged-in session past an auth wall.
- **Enterprise licensing** — `reticle license` shows activation status; offline Ed25519 keys (`RETICLE_LICENSE_KEY`) verify locally with **no phone-home**. Open-core split: Apache-2.0 SDK, FSL server/CLI, Reticle Enterprise License for `ee/` features.
- **Branded id types** — `RunId` is nominal end-to-end, so ids can't be confused with flow names.

### Changed

- **Hardened persistence + HTTP boundary** — atomic run writes, bounded `.reticle/runs` retention, verify-server request/timeout limits, a frozen contract-lock test, and path-traversal guards on read and write.

### Fixed

- Oracle-backed flows now report **high** confidence — the success consequence propagates into the verdict instead of reading as a smoke test.
- A localhost preview connects to the bridge without a token mismatch; hosted-preview origins are allow-listed.

## [0.8.0] — 2026-06-20

The "developers love it" release. 0.7.0 won the agent; 0.8.0 wins the human — the dev who watches the agent work, points at what's wrong, and trusts the green.

### Added

- **Human review marks — "annotate the bug where you see it"** (`packages/browser`, `packages/server`, `packages/protocol`). A dev-only **"Flag a bug"** button rides with the presenter: the human toggles it, clicks the element that looks wrong, types what's wrong, and Reticle drops a numbered pin + emits a `HUMAN_MARK`. The mark carries the element's re-resolvable anchor (the same durable address a recorded flow uses) **and the source `file:line`** — so the agent fixes the exact element and code, not a guess. The agent drains marks with the new **`reticle_review`** tool: each pending mark comes with a ready-to-act `fix` hint (`Open src/Checkout.tsx:42 and fix: <note>. Then reticle_review { resolve: m1 }`), reading never consumes a mark, and `resolve` retires it once fixed. Off the deterministic benchmark path (human-driven) — `pnpm bench` unchanged.
- **First-run readiness + loop intro — `reticle_wait_ready`** (`packages/server`). Call it right after init: it blocks until the app's SDK connects (returns instantly if a session already exists, so zero latency on the happy path and on the benchmark), or times out with a `recovery` hint. Smooths the most common first-5-minutes footgun — the agent's first real call racing the WebSocket connect. Its ready response also carries a one-line **`loop` guide** (look → act → observe → assert → regress, plus the human-flag → `reticle_review` loop), so a fresh agent learns how to drive Reticle on its first call without reading docs. Pure, injected clock/sleep; off the benchmark path.
- **Deterministic visual regression — `reticle_viewport`** (`packages/server`). Pin the driven page to a fixed viewport size (clamped to sane bounds) so a screenshot baseline is reproducible across machines — the last missing piece of CI-stable visual diffing, alongside the already-shipped `reticle_visual_diff` `masks` (neutralize volatile regions) and a frozen clock (`reticle_clock`). Drive-only, additive; off the benchmark path. Provider-driven and tested via a fake page like `reticle_network_mock`.
- **CDP network mock / intercept — `reticle_network_mock`** (`packages/server`). On a driven page (`reticle drive`), stub a request deterministically: return a `500`, force offline (abort), or delay a response — so "verify the app handles a failed payment" is one declared rule, no backend changes. The matcher is pure (first rule whose url-substring + optional method matches wins → fulfill/abort/continue) and the Playwright `page.route` wiring is driven in tests with a fake Page/Route. Needs a driven browser; returns a `recommendation` to `reticle drive` otherwise. Off the agent/benchmark path.
- **`reticle status` shows sessions + health at a glance** (`packages/server`). The daemon exposes a local `GET /status`; `reticle status` now reports each connected tab (url, throttled, stale, pending human marks) and the session count — not just "running: pid". The plan's "no more pkill in a README" daemon DX. Local-only, off the agent/benchmark path.
- **Actionable error recovery** (`packages/server`). Every tool error returned to the agent now carries a `recovery` hint when the failure is recognized — the no-session footgun, multiple/unknown sessions, a throttled tab, a missing baseline/recording, the pairing-token config — so the first 5 minutes never dead-end on "what do I do now?". Conservative: an unrecognized error gets no invented advice.
- **The panel always reflects the agent's real state — `reticle_yield`** (`packages/server`, `packages/browser`, `packages/protocol`). A human watching the browser must never see "live" when the agent has actually stopped. The agent signals its turn boundary with **`reticle_yield({ mode: "waiting" })`** (done responding, will resume on your next message) or **`{ mode: "ask", note }`** (blocked, needs your answer — the question shows on the panel); the session is revived automatically on the agent's next call. Taught as the mandatory last step in the session lease, the loop guide, and the skill — and it's **agent-independent** (Codex / OpenCode / Claude / Hermes). The panel renders each handback distinctly via a PRESENTER `tone`: waiting = calm teal ✋, ask = amber ❓ pulse, **agent crashed/disconnected** = amber ⚠ pulse, a clean end = calm green. When the last agent's MCP connection drops, the daemon ends every session and pushes the "switch to your terminal" notice (verified end-to-end through a SIGKILL-ed agent). Off the benchmark path.
- **Don't lose a panel prompt in the death-race** (`packages/server`, `packages/protocol`). If the human types a message into the panel at the exact moment the agent stops, it would land in a dead inbox; now both the agent-detach and idle paths fold any unread note into the end banner — quoted and labeled `Undelivered (paste into your terminal): "…"` — so the words are surfaced back, not silently dropped.
- **Replay a saved flow from the panel — no agent** (`packages/browser`, `packages/server`, `packages/protocol`). The daemon pushes the saved-flow names to the HUD on connect; the human clicks **▶** on a flow and it re-runs with no agent in the loop — the page animates via the normal replay path and the ✓ / ⚠ drift / ✗ verdict lands in the same activity log they watch the agent in. The dev plays the regression suite directly. Off the benchmark path (a panel-driven control, not a tool).

### Changed

- **Internal cohesion split** (no behavior change): `SessionManager` moved to its own `session-manager.ts`, and the on-disk-artifact constants to `flow-constants.ts`, bringing both parent files back under the 500-line cap. All public import paths unchanged (re-exported).

### Fixed

- **Panel composer is now multi-line** (`packages/browser`). The HUD message box was a single-line `<input>` that sent on any Enter; it's a `<textarea>` now — **Enter sends, Shift+Enter inserts a newline**, and it auto-grows to fit.
- **Flag mode keeps the right cursors** (`packages/browser`). In "Flag a bug" mode every element showed the crosshair, including the Flag button and its popover — which are clickable; they keep the pointer cursor now. And the hover outline that boxes the element under the cursor no longer snaps jumpily: it **waits for the cursor to rest (~130 ms), then glides into place on an ease** and fades in.

## [0.7.0] — 2026-06-20

The regression-testing release. Reticle's flow `success` is now a **declared, deterministic, post-settle consequence** over program truth — not just "the element is there" — and the same flow replays with no LLM, so a CI gate diffs the verdict exactly (0% flake) at a fraction of the tokens an LLM re-drive costs.

### Added

- **`state` predicate — assert store truth** (`packages/server`, `packages/protocol`). Assert a value inside a registered store the DOM never showed: `{ kind: "state", store?, path, equals? }`, with `equals` a literal or a `{ $gte | $contains | $length }` operator. Available in `reticle_assert`, `reticle_act_and_wait`, as a per-step `assert-state` invariant, and as a flow `success-state` golden end-condition. Catches a UI-vs-store **desync** and a dead-handler **green-but-wrong** regression that no DOM read can — the success oracle fails when the store didn't change, with no testid drift.
- **Flow consequence family — `net { count }`, `console { absent }`, `state { hold }`** (`packages/server`, `packages/protocol`). A flow's `success` (via `reticle_annotate success-state`) now compiles to a real predicate over more than presence: `net { count }` asserts a request fired EXACTLY N times (catches a **double-submit** / retry-storm a presence check passes); `console { absent }` asserts the action left a **clean console** (catches a silent `console.error`); `state { hold }` asserts an unrelated store path **did not move** (catches an action's unintended **blast-radius** side-effect). Cardinality/absence/invariant predicates are read **post-settle** so a wait-until-true check can't pass before the regression lands.
- **Design-token awareness in `reticle_inspect`** (`packages/server`, `packages/browser`). Inspect now reports theme compliance — `{ colorToken, backgroundToken, offTheme, tokenCount }` — so an off-palette color (a value no design token defines) is observable in one call, not just "a color rendered."
- **React render meter** (`packages/react`). `installRenderMeter()` augments the React DevTools hook to count commits and registers an `__reticle_renders` store; `reticle_state` reads the commit rate, so a **wasted-render storm** (re-renders with identical output → no DOM mutation) is visible where a screenshot/DOM tool sees an idle page. `getRenderStats()` / `resetRenderMeter()` exported; host-safe.
- **Component auto-anchors — address any element with zero hand-added testids** (`packages/browser`, `packages/server`). `reticle_query by:"component"` resolves elements by component identity / source location, and recorded flows synthesize a stable `component` anchor (fiber → component → `file:line`) when no `data-testid` resolves, instead of degrading the step.
- **`reticle_flow_verify` — one-call suite regression check** (`packages/server`). Re-verify a K-flow suite and get one consolidated verdict (passing counted, only failures detailed), so an agent's read-cost is roughly constant in suite size.
- **On-demand tool loading — `dynamic` / `hybrid` MCP profiles** (`packages/server`). Load tool schemas as needed instead of paying for the full set up front, cutting the agent's per-turn token floor.
- **Richer observation** (`packages/browser`, `packages/server`): a `net.pending` signal for in-flight / hung requests; generic-container text in the snapshot so a silent DOM removal is visible; a grid layout signature so a CLS/layout regression shows up.

### Changed

- **Leaner agent verify loop** (`packages/server`). Terser tool descriptions and compact `reticle_network` / `reticle_console` projections on the lean profiles roughly halve the per-turn token cost; `core` is the default profile tuned for the build-verify loop.

### Fixed

- **`reticle_visual_diff` returned a shape its schema rejected** (`packages/server`). The tool's `outputSchema` declared `{ ok, match, diffPct }` but the handler returned the diff engine's real shape (`{ matched, changedPixels, ratio, … }`) and never set `ok`, so every real diff failed MCP output validation. The schema now matches the handler (`ok` plus the real fields); dimension-mismatch returns `{ ok:false, reason }`.
- **`reticle_flow_save` / `reticle_save_recorded` output schemas didn't match their handlers** (`packages/server`), breaking those tools over MCP. Schemas corrected.
- **`reticle_state` output validation + path scoping** (`packages/server`, `packages/protocol`). `reticle_state` no longer fails output validation, and `path`/`depth` selection is applied **in-page before transport truncation**, so a scoped read of a large store is no longer truncated to the wrong fields.
- **Transport sanitizer no longer redacts design-token fields** (`packages/browser`). A broad `token` redaction rule was clobbering `colorToken` / `tokenCount`; it's now scoped to auth-credential patterns.

## [0.6.10] — 2026-06-18

### Added

- **Deterministic waiting — the `settled` predicate** (`packages/server`). A new predicate `{ kind: "settled", quietMs }` passes once network + structural-DOM activity has been quiet for `quietMs` (default 500ms); ambient `dom.text`/animation churn (count-ups, spinners) is ignored so an animated page can still settle. Usable in `reticle_wait_for` and `reticle_assert`, and composable inside `allOf` with the consequence you expect. Replaces fixed sleeps — the #1 cause of flaky agent tests.
- **`reticle_act_and_wait` auto-settle** (`packages/server`). Omit `until` and the tool waits for the page to settle instead of requiring a predicate — "act, then wait for quiet" is now a single zero-config call, the documented alternative to a sleep.
- **`reticle_query` token controls** (`packages/server`) — `limit` (cap returned descriptors; reports `total` + `truncated` so a trim is never silent) and `count_only` (return just the match count).
- **`reticle_network` / `reticle_console` token controls** (`packages/server`) — `limit` (keep the most recent N matches, reporting `total` + `droppedOldest`) and a `cost:{bytes,tokens}` hint, matching the other read tools so the agent can self-budget everywhere.
- **`reticle_domain` `mustHold` per flow** (`packages/server`) — each flow now reports the success consequence that must hold for it (signal name / net URL), so an agent can answer "what are the critical flows and what must hold for each?" from the domain model alone.

### Changed

- **Self-healing now verifies the consequence before persisting** (`packages/server`). `reticle_flow_heal` with `apply:true` re-replays the healed flow and re-asserts its success consequence; if a rebound locator resolves but the flow no longer satisfies its intent, the write is **refused** (`status:consequence_broken`, file untouched). It heals the locator, never the intent.

### Fixed

- **Browser observers fully restore patched globals on teardown** (`packages/browser`). The network, route, and console observers stored a bound copy and assigned it back on teardown, so `window.fetch` / `history.pushState` / `console.*` were never restored to their original identity. They now keep the true original for restore and a bound copy only for invocation.

## [0.5.0] — 2026-06-15

### Added

- **`reticle mcp` — smart proxy with auto-start** (`packages/server`). Run `reticle mcp --drive <url>` and you're done: it starts the daemon if one isn't running, waits for it to be ready, then bridges Claude Code's stdin/stdout to the daemon's SSE endpoint. Users no longer manage the daemon manually.
- **`reticle mcp --drive <url>` / `reticle serve --drive <url>`** — pass a URL and Reticle launches its own Playwright browser at that URL, giving the agent full autonomous control without relying on the user's open browser tab.
- **`reticle mcp --headed` / `--headed` flag** — opt in to a visible browser window so you can watch exactly what the agent is doing.
- **Three new update MCP tools** (`packages/server`):
  - `reticle_version_info` — returns the installed version, execution kind (npx / global / local), and whether a newer version is available on npm.
  - `reticle_apply_update` — upgrades Reticle in place; requires `confirm: true` to actually run.
  - `reticle_rollback` — downgrades to the previous version; requires `confirm: true`.
- **Presenter mode** (`packages/browser`, `packages/server`) — `reticle.connect({ present: true })` mounts a dev-only HUD overlay that the agent can control: `reticle_narrate` shows a caption, `reticle_highlight` draws a ring around any element. The HUD is excluded from snapshots and tree-shaken in production.
- **Unified `SKILL.md` at repo root** — a single skill file auto-detects mode: setup wizard on first run (no `.reticle.json`), live-app testing on every run after. Covers Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, VS Code, and Zed MCP config formats.
- **`.reticle.json` project config** — written after first-run setup; persists `port`, `headed`, `framework`, and `harnesses` so subsequent runs need zero questions.
- **`dev:reticle` script** in `apps/demo` — second Vite dev server on port 4310, isolated from the user's normal dev port.

### Fixed

- **All-throttled session auto-selection** (`packages/server`). When every connected tab is hidden (e.g. user is in VS Code with Chrome on another desktop), `SessionManager.resolve()` now picks the session with the freshest heartbeat instead of throwing `"multiple sessions connected"`.
- **Presenter HUD shows on bridge connect** — the overlay now mounts as soon as the SDK connects to the bridge, not only after the first `reticle_narrate` call.
- **`reticle_narrate` MCP schema validation** — relaxed the output schema so the tool no longer rejects responses from narration calls.
- **`reticle_inspect` / `reticle_clock` output schemas** — relaxed to pass through extra fields instead of stripping them, fixing spurious validation errors.

---

## [0.4.0] — 2026-06-11

First public release. Reticle is the **proof layer for AI agents** — it verifies your running web app from the inside and returns a **verdict with evidence** instead of a screenshot.

### Added

- **The verify loop over MCP** — `look → act → observe → assert`. `reticle_assert` evaluates a structured predicate against the live app and returns `{ pass, evidence, failureReason? }`, typically in ~100 tokens.
- **Six reaction types in one assert** — network calls, DOM changes, SPA navigation, console & errors (including "no errors during this flow"), animations, and app **signals**.
- **App signals** — `reticle.signal()` lets your app emit the facts a screenshot can't see (the store committed, the webhook arrived); a bundled ESLint rule flags mutations that forgot to emit one.
- **Regression detection** — `reticle_baseline_save` + `reticle_diff` to catch silently removed elements or new console errors before they ship.
- **Source mapping** — DOM element → React component → `file:line`, on React 18/19 and Next.js (keeps SWC).
- **Autonomous crawler** (`reticle_crawl`) that clicks every reachable control and classifies what breaks.
- **Declarative spec runner** (`@reticlehq/core/test`) for signal-bound, headless verification specs.
- **The `reticle` CLI** — bridge + MCP server, plus `reticle drive` for a launched browser.
- **Single package, subpaths** — `@reticlehq/core` ships the browser SDK (`.`), the server (`./server`), the spec runner (`./test`), source mapping (`./next`, `./babel`), and the lint rule (`./eslint`) — one install.

### Notes

- **Dev-only and localhost-only by default**; observers are additive and reversible, and the SDK is tree-shaken out of production. No telemetry.
- **Token efficiency** — a full verify loop is ~100 tokens vs ~7,300 for a full-tree snapshot (~73× on the common loop; ~1.8× full-tree-vs-full-tree). See [`docs/token-efficiency.md`](docs/token-efficiency.md) for the methodology and honest caveats.

[1.0.0]: https://github.com/reticlehq/reticle/releases/tag/v1.0.0
[0.9.0]: https://github.com/reticlehq/reticle/releases/tag/v0.9.0
[0.8.0]: https://github.com/reticlehq/reticle/releases/tag/v0.8.0
[0.7.0]: https://github.com/reticlehq/reticle/releases/tag/v0.7.0
[0.6.10]: https://github.com/reticlehq/reticle/releases/tag/v0.6.10
[0.5.0]: https://github.com/reticlehq/reticle/releases/tag/v0.5.0
[0.4.0]: https://github.com/reticlehq/reticle/releases/tag/v0.4.0
