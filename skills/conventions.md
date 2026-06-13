# skills/conventions.md — Naming, Constants, Quality

**Open when:** before naming anything or deciding whether to abstract. (Foundation II.8.)

## No free strings

Before writing a feature, list the string/number constants it needs and add them first.

- **Wire/protocol** strings → `packages/protocol/src/constants.ts` (shared contract).
- **MCP tool names** → `packages/server/src/tool-names.ts`.
- **Demo/UI** strings → `apps/demo/src/constants/`.

Pattern: `as const` object + same-named derived type, barrel-exported via `index.ts`.
No literal domain strings in application code — ever.

## Naming

See the table in `CLAUDE.md`. Highlights: files kebab-case, types PascalCase, constant
objects PascalCase + `as const`, `useX` only for real hooks, `create-` prefix for
creation-flow component files (not `new-`).

## Quality metrics that matter

- **Cyclomatic complexity:** keep functions ≤ 10. A function of complexity N needs N tests
  for branch coverage. Use the eslint `complexity` rule if a file gets hairy.
- **Coupling:** `@iris/protocol` is high-afferent (everything depends on it) so it must be
  maximally stable and depend on nothing. Don't let it grow dependencies.
- **500-line cap:** at the limit, stop and split — extract constants, utilities,
  sub-modules. Commit the refactor before the feature.

## No internal tracking tags

Comments, file names, directory names, and test `describe`/`it` strings must never contain
design-doc reference codes or internal version strings. These are not appropriate in
production code — they rot, confuse new contributors, and pollute search results.

**Forbidden patterns:**

- Single-letter + digit codes: `N5`, `G4`, `M8`, `P2`, `F1`, `R1`, `G2`, etc.
- Version strings used as labels: `0.3.7`, `0.3.10`, etc.
- Hybrid forms: `M8 Stage A`, `0.3.7 FLUENCY`, `N5 SCROLLFIND`, `P2-drive`

**Replace with prose.** Instead of `// N5: scroll-find first pass`, write what it actually
does: `// scroll until the target element enters the viewport`. Instead of a test named
`'F1: settle is bounded'`, name it `'settle resolves with dispatched:true when rAF never fires'`.

The pre-commit hook rejects any staged file whose comment lines match `\b[A-Z]\d+\b` or
embed a `\d+\.\d+\.\d+` version string in comment text.

## Rule of Three over premature DRY

Copy once = example. Twice = coincidence. Three times = extract. The third occurrence
reveals the correct axis of abstraction. A 12-parameter "generic" helper is worse than
three honest copies. This applies hard to the observers — they look similar but diverge;
don't over-unify them before the third one exists.
