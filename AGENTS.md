# AGENTS.md — Iris

Orientation and tool manifest for AI agents working in this repo. Pairs with `CLAUDE.md`
(rules) and `skills/` (depth).

## Orient before you explore

1. Read `CLAUDE.md` for the non-negotiables and the skills index.
2. Read `plan/README.md` for the product design (then the specific `plan/0N-*.md` for your area).
3. Read `GRAPH_REPORT.md` (if present, from Graphify) before grepping across packages.
4. Open the one `skills/*.md` that matches your task — don't reread all of them.

## The codebase in one breath

TypeScript pnpm+turbo monorepo. `@syrin/iris-protocol` is the shared contract; `@syrin/iris-browser`
instruments a page; `@syrin/iris-server` is the bridge + MCP server; `@syrin/iris-react` maps DOM →
source file; `apps/demo` is the dogfood dashboard. One git repo at root. `plan/` is
gitignored research.

## Tool manifest

| Tool                                                 | Use                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `pnpm build / lint / typecheck / test:unit / format` | The quality gates — run before declaring done                                             |
| `iris` (from `@syrin/iris-server`, M0+)              | Start the bridge + MCP server                                                             |
| Graphify                                             | Knowledge graph per package; read `GRAPH_REPORT.md` first. `/graphify packages/<pkg>/src` |
| Agentation (`agentation-mcp`)                        | Human UI annotations in the demo → agent context (complementary to Iris)                  |
| Refero                                               | Design references: `/refero <niche>` → fold tokens into `skills/design.md`                |
| MCP servers                                          | Reach session-connected MCP tools via the harness                                         |

## Working rules for agents

- **Contract-first:** change `@syrin/iris-protocol` (constant + zod schema) before either side.
- **Constants-first:** add the named constants a feature needs before writing it.
- **Tests-first:** RED → GREEN → REFACTOR. Inject the clock; never read it in pure logic.
- **Stay in your lane:** `browser` is DOM-only, `server` is Node-only, `protocol` depends on
  nothing.
- **Never break the host app:** observers are additive and reversible.
- **Done = green:** `pnpm lint && pnpm typecheck && pnpm test:unit` pass, no `any`, no free
  strings, no file > 500 lines.

## Multi-agent orchestration

For broad sweeps (e.g. "audit every observer for the never-break-the-host rule" or "design
N approaches to the predicate DSL"), fan out read/verify agents per package and synthesize —
each package is an independent unit of work. Keep `@syrin/iris-protocol` changes single-threaded
(it's the shared contract; parallel edits conflict).
