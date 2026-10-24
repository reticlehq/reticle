# AGENTS.md — Reticle

The rules for every agent and every person who changes this repository. Claude Code, Codex, Cursor, Gemini, Copilot and OpenCode all read this file. `CLAUDE.md` imports it. Humans start with [`CONTRIBUTING.md`](CONTRIBUTING.md), which links back here.

## What Reticle is

Reticle is the proof layer for AI agents. It verifies a running app from the inside, without screenshots. The app embeds a development-only SDK. A local bridge and MCP server give an agent tools to look, act, observe and assert.

## Layout

This is one pnpm + turbo monorepo. There is no `packages/` directory.

```
core                          @reticlehq/core          — the wire contract: constants and zod schemas (deps: open-verification, zod)
open-verification             open-verification        — the Open Verification Protocol: vocabulary, rules, Realm, adjudicate() (deps: zod)
engine                        @reticlehq/engine        — the rules that decide a verdict; no browser, daemon or CLI
conformance                   —                        — runs the protocol's scenarios against an implementation (private)
server                        @reticlehq/server        — bridge, MCP server and the `reticle` CLI (Node only)
init                          @reticlehq/init          — `reticle init`: writes files, no runtime (Node only)
spec-runner                   @reticlehq/test          — spec runner and matchers for CI (peer vitest)
adapters/realm/browser        @reticlehq/browser       — the SDK in the app (DOM only)
adapters/realm/electron       @reticlehq/electron      — Electron main-process adapter
adapters/realm/cli            @reticlehq/cli-realm     — realm for a command-line subject (Node only)
adapters/realm/tauri          reticle-tauri            — Tauri capture backend (Rust; no JS gate compiles it)
adapters/framework/react      @reticlehq/react         — React adapter: DOM node to component to source file
adapters/build/vite           @reticlehq/vite-plugin   — Vite: stamps source, injects connect()
adapters/build/babel-plugin   @reticlehq/babel-plugin  — stamps data-reticle-source (plain CJS)
adapters/build/next           @reticlehq/next          — Next.js source mapping, keeps SWC (plain CJS)
adapters/lint/eslint          @reticlehq/eslint-plugin — lint rule: state changed, so a signal fired
apps/                         —                        — fixtures the gates drive; see apps/README.md
bench/                        —                        — measurement and research; not a gate
break/                        —                        — hostile-environment harness; never shipped
install/                      —                        — the one-line installers served from reticle.sh
docs/                         —                        — user docs and contributor docs
scripts/                      —                        — repository tooling
```

Do not confuse three directories. `install/` puts the CLI on a machine. `init/` wires Reticle into a project. `server/src/command/setup/` boots the app and drives it.

`SKILL.md` is a product surface: users paste its URL into their agent. `docs/skill.md` is a copy, and a test keeps the two the same.

## Boundaries

- **`core` is the contract.** Every message between browser, bridge and agent is a constant plus a zod schema in `core`. Never write a wire string inline in `browser` or `server`. `core` depends only on `zod` and `open-verification`.
- **`adapters/realm/browser` touches only the DOM.** It never imports a Node API.
- **`server` runs only in Node.** It never uses a DOM API.
- **`init` runs only at build time.** It writes files and runs the package manager. It never opens a socket and imports nothing from `server`. It gets everything else through `InitHost` on `InitIo`.
- **`@reticlehq/react` is optional.** Everything works without it.

## Rules

Lint and review enforce these rules.

1. Use `===` and `!==`. `eqeqeq` is an error.
2. Do not use `any`. Use `unknown` and narrow it with zod at a boundary.
3. Do not use free strings. Every domain, wire and UI string is a named constant.
4. Do not use the non-null `!`. Use optional chaining and explicit null checks.
5. Write the test first: red, green, refactor. A bug fix starts with a test that shows the bug.
6. Keep a shipped source file under 1,000 lines. The real rule is cohesion; the number is a backstop. Tests, `apps/`, `bench/`, `break/` and `test/` are exempt.
7. Inject the clock. Pure logic never calls `Date.now()` or `Math.random()`.
8. Scope every data access to the authenticated principal.
9. Design values live only in design tokens.
10. Do not leave `console.log` in committed code. Do not disable a lint rule; change the code so it passes.
11. A lossy transform declares its loss. If a transform on a path that an agent reads can drop or shorten data, it reports that in a field the caller can check. `scripts/check-lossy-transforms.mjs` enforces this.
12. Telemetry is part of the feature. A new tool goes in `TOOLS`, and in `VERDICT_TOOLS` if it gives a verdict (`server/src/surface/tools/feedback-tools.ts`). A new finding kind goes in the enum in `core`. A dispatch path that skips `runTool` needs its own reporter. Telemetry fails silently, so read [`contributing/telemetry/contract.md`](contributing/telemetry/contract.md) before you change anything that sends an event. [`contributing/telemetry/events.md`](contributing/telemetry/events.md) lists every event and field.
13. A new guard (a test about the repository, not the product) must name the shipped defect it would have caught, in its header. "This could drift" is not a defect. Fix the one shared function before you add a guard that watches its callers.
14. Accuracy comes before tokens. A change that makes Reticle cheaper ships only with a measurement that shows its verdicts are still correct. A false verdict costs more than every token it saves.
15. Do not assert a duration. A timing assertion fails only under load, which means only in CI. Assert a bound (an output size, a flag) or use a generous per-test timeout.
16. Write 80% of the way to ASD-STE100 (Simplified Technical English). This applies to docs, comments, the changelog, commits, PRs, tool output, error messages, prompts and `SKILL.md`. It also applies to the text that Reticle tells agents to save. Use short sentences (about 20 words for an instruction, 25 for a description) and one topic for each sentence. Use the active voice and simple tenses. Write instructions as commands. Give each word one meaning, and use the same word for the same thing. Do not use idioms or slang. The other 20% is a permission: names, identifiers and necessary technical terms stay as they are. `@reticlehq/core` exports the rule for prompts as `WRITING_RULE`.
17. Write for the reader, not for the shortest line. Do not nest a ternary inside a ternary. Use `if`/`else`, an early return or a lookup table. One plain `a ? b : c` is correct. Every `if` and `else` is a block in curly braces: `if (x) return y;` hides where the branch ends, and a line added under it runs every time. `no-nested-ternary` and `curly: all` are errors. Each package's `eslint-suppressions.json` records the nested ternaries and unbraced branches that were there when each rule started. Do not add to it. When you change a file for another reason, remove its nested ternaries and add the braces (`npx eslint --fix <file>`), then run `npx eslint src --prune-suppressions` in that package. `pnpm lint` fails until a fixed site leaves the record, so the record can only get smaller.

## Names

| Thing                | Convention                        | Example                            |
| -------------------- | --------------------------------- | ---------------------------------- |
| Package              | `@reticlehq/<kebab>`              | `@reticlehq/browser`               |
| File                 | kebab-case                        | `ring-buffer.ts`                   |
| Type or class        | PascalCase                        | `RingBuffer`                       |
| Variable or function | camelCase                         | `pushEvent`                        |
| Constant object      | PascalCase with `as const`        | `EventType`                        |
| React component file | PascalCase, or a `create-` prefix | `App.tsx`                          |
| `useX` function      | only if it calls React hooks      | otherwise `apply/build/get/handle` |

## Before you commit

1. Look for code to reuse. Add the constants you need. Write the failing test.
2. Make it pass. Refactor with the tests green.
3. Run **`pnpm verify`** as one command. It is `format:check && lint && typecheck && test:unit`. Do not run the four parts on separate lines. Then only the last one sets the exit code, and a failure in the middle looks like a pass. `pnpm format` fixes formatting.

A fresh worktree has no build output. Run `pnpm build` once before `pnpm verify`.

## Which gate to run

Every change runs `pnpm verify`. Some changes need one more gate. [`docs/gates.md`](docs/gates.md) has the full table, what each gate cannot see, and the CI job for each.

| If you changed | Also run | Time |
| --- | --- | --- |
| the tool surface, the wire contract (`core`), or an observer | `pnpm test:e2e` | ~8 min |
| telemetry, feedback, or anything that sends an event | read the telemetry contract, then `pnpm test:e2e` | ~8 min |
| `open-verification`, the adjudicator, `WebRealm`, or anything a verdict comes from | `pnpm gate:conformance` | ~3 min |
| Electron, Tauri, the IPC observer, or desktop capture | `pnpm test:e2e:desktop` | ~3 min |
| `reticle init`, the Vite or Next plugin, or anything before a user's first session | `pnpm gate:install` | ~15 min |
| anything, and you want fast product feedback | `pnpm test:smoke` | — |

The batteries use bridge port `14400`, so a daemon of your own on `4400` can keep running. Never `kill -9` whatever holds `4400`: that can be the `reticle mcp` proxy, and killing it cuts your agent's link with no log.

## Commits and pull requests

1. Branch from `main`. Update your branch with `git rebase origin/main`. Do not merge `main` into it: the merge queue cannot take a branch with merge commits.
2. Sign off every commit with `git commit -s`. CI's DCO check fails a commit without a `Signed-off-by:` line. `pnpm hooks:install` adds the line for you.
3. Use Conventional Commits, for example `fix(browser): restore patched fetch on teardown`.
4. For a user-facing change, add one file to [`.changes/`](.changes/README.md). Do not edit `CHANGELOG.md`; only a `release/` branch does that.
5. Link the issue in the PR (`Closes #123`). Before you start, claim the issue with a comment, and look for an open PR that already fixes it.
6. Prove that your test fails without your change. Revert the fix, run the test, and see it fail. Say in the PR that you did this.
