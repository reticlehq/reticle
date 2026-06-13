# Welcome to Iris 👁️

**Iris gives AI coding agents eyes into a running web app — without screenshots.**
Your app embeds a dev-only SDK; a local bridge + MCP server lets your coding agent _look,
act, observe, and assert_ on real runtime behavior (DOM, network, routes, console,
animations, framework state). It's Testing Library + network/console/route observability,
exposed over MCP.

## Directory structure

```
iris/  (this repo — one git repo, pnpm + turbo monorepo)
├── packages/
│   ├── protocol/      @syrin/iris-protocol     — shared wire contract, constants, zod schemas
│   ├── browser/       @syrin/iris-browser      — instrumentation SDK embedded in the app (DOM-side)
│   ├── server/        @syrin/iris-server       — bridge + MCP server, the `iris` CLI (Node-side)
│   ├── react/         @syrin/iris-react        — React adapter: DOM ref → component → source file
│   ├── babel-plugin/  @syrin/iris-babel-plugin — stamps data-iris-source (source mapping, React 19)
│   └── next/          @syrin/iris-next         — Next.js source mapping (keeps SWC) via withIris
├── apps/
│   ├── demo/          @syrin/iris-demo         — Vite/React dashboard to dogfood Iris
│   ├── api/           @syrin/iris-api          — Express backend exercising real-world behaviors
│   └── next-smoke/    @syrin/iris-next-smoke   — Next.js 15 app verifying Iris on Next
├── docs/             — user-facing docs (getting-started, usage, token-efficiency, local-install)
├── skills/           — engineering reference docs (open the one matching your task)
├── plan/             — product design & roadmap + throwaway test harnesses (GITIGNORED)
├── CLAUDE.md         — master rules + skills index
├── AGENTS.md         — agent orientation + tool manifest
├── COMMIT.md         — pre-commit checklist
└── pre-commit.sh     — automated quality gate
```

> `apps/api` and `apps/next-smoke` are local fixtures/examples (excluded from the build/lint/
> test gates). `@syrin/iris-babel-plugin` and `@syrin/iris-next` are plain CJS tooling (no build step).

## First 5 commands

```bash
pnpm install          # install everything (already done if you're reading this)
pnpm build            # compile all packages (tsc -b via turbo)
pnpm --filter @syrin/iris-demo dev   # run the demo dashboard at http://localhost:3000
pnpm lint && pnpm typecheck && pnpm test:unit   # the quality gates
cat docs/getting-started.md   # how the product is used; plan/NEXT-PHASES.md for what's next
```

> Status: M0–M5 shipped + verified (Vite/React demo 16/16, Next.js 15 smoke 5/5). See
> `plan/ROADMAP.md` and `plan/NEXT-PHASES.md` for the forward plan.

## File → when to open it

| File                      | Open when                                     |
| ------------------------- | --------------------------------------------- |
| `docs/getting-started.md` | Installing/using Iris in an app               |
| `docs/usage.md`           | Tool reference, predicate DSL, cookbook       |
| `plan/README.md`          | Understanding the product (design docs index) |
| `plan/NEXT-PHASES.md`     | Deciding what to build next                   |
| `CLAUDE.md`               | Anytime — the non-negotiable rules            |
| `AGENTS.md`               | You're an agent orienting in the repo         |
| `skills/design.md`        | Building any UI or the dev overlay            |
| `skills/typescript.md`    | A TypeScript pattern or rule                  |
| `skills/python.md`        | N/A — pure TS repo                            |
| `skills/testing.md`       | Before writing any feature                    |
| `skills/conventions.md`   | Naming or constants                           |
| `skills/agents.md`        | Designing the MCP tool surface                |
| `skills/architecture.md`  | New package or wire-contract change           |
| `skills/database.md`      | Persistence (baselines/recordings)            |
| `skills/security.md`      | Bridge transport, actions, data capture       |
| `skills/performance.md`   | Anything slow or memory-hungry                |
| `skills/observability.md` | Logs/metrics, debugging the bridge            |
| `skills/api-design.md`    | Any new MCP tool                              |
| `skills/cicd.md`          | Build pipeline, CI, releases                  |

## The non-negotiables

1. `===` always (never `==`).
2. No `any` — `unknown` + zod at boundaries.
3. No free strings — named constants (`protocol` / `tool-names` / demo `constants/`).
4. Tests first — RED → GREEN → REFACTOR; inject the clock.
5. 500-line file cap.
6. Design values only in `tokens.ts`.
7. Contract changes go through `@syrin/iris-protocol` first.

## Installed tools

- **pnpm + turbo** — monorepo install & task orchestration.
- **TypeScript (strict++), ESLint (type-aware), Prettier, Vitest** — quality gates.
- **Graphify** — knowledge graph per package; read `GRAPH_REPORT.md` before exploring.
- **Agentation** — human UI annotations → agent context (in the demo; complements Iris).
- **Refero** — design references (`/refero <niche>`).

## Manual follow-ups (need your input / a key)

These couldn't be completed automatically in the scaffold:

1. **Graphify graph build** — installed (`graphify` 0.8.27) but extraction needs an LLM key.
   Run once a key is set:
   ```bash
   export ANTHROPIC_API_KEY=...   # or GEMINI_API_KEY / OPENAI_API_KEY
   graphify packages --no-viz && graphify apps/demo/src --no-viz
   ```
2. **Claude Code plugins** (slash commands — run inside Claude Code, not the shell):
   ```
   /plugin install superpowers@claude-plugins-official   # plan→TDD→review workflow
   /plugin install ecc@ecc                               # AgentShield security scanning
   ```
3. **Agentation MCP** — the `agentation-mcp` server is already connected to this session.
   If it isn't in a fresh session: `npx add-mcp "npx -y agentation-mcp server"`.
4. **Publish to npm** — packages are publish-ready but not on public npm yet. To use Iris in
   an external app today, see [`docs/local-install.md`](docs/local-install.md) (local
   registry). For public release: `npm login` then `pnpm -r publish --access public`.

## What's next

M0–M5 are shipped and verified. The forward plan (commit the e2e suite + CI, publish,
virtualized lists, Vue/Svelte adapters, Next/SWC source map, visual layer, hosted bridge,
perf) is fully specified in **`plan/NEXT-PHASES.md`**, with the condensed list in
`plan/ROADMAP.md`.
