# skills/agents.md — Agents & MCP Tool Design

**Open when:** designing the MCP tool surface or multi-agent workflows.

## Iris IS an agent tool — design for the agent's loop

The whole product is consumed by a coding agent. The loop is **look → act → observe →
assert**. Optimize every tool for that loop:

- **Few, composable tools** (~15, listed in `packages/server/src/tool-names.ts` and
  `plan/05`). More tools = more agent confusion and tokens.
- **Return evidence, not prose.** Tools return structured data (reaction reports, diffs)
  the agent reasons over — never human-prose summaries.
- **Token discipline.** Snapshots take `scope`/`mode`; observe takes `filters`/`window_ms`.
  Cost is a first-class concern (it's why screenshots lose).
- **Every act is `since`-cursored** so act→observe can't race.

## Tool schema conventions

Mirror WebMCP's shape: `name` (from `IrisTool`), `description` (one line, agent-facing),
`inputSchema` (zod → JSON Schema). Read-only tools (snapshot/query/observe/assert) are
safe; state-changing tools (act) honor the action blocklist (`skills/security.md`).

## Failure output is a feature

When `assert`/`wait_for` fails, return diagnostic evidence: the near-miss, console errors
(source-mapped via `@iris/react`), and the snapshot delta. This is what lets the agent
self-correct instead of re-screenshotting. Never return a bare `false`.

## Relationship to other agent tools

- **Agentation** (installed in the demo) = human → agent annotations. Complementary;
  Iris is agent-driven observation. Both can run together.
- **WebMCP** = if a site exposes `navigator.modelContext` tools, Iris dispatches them via
  `act({action:'webmcp'})`. Don't reimplement actions a site already exposes.
