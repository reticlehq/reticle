# CLAUDE.md — Iris

> Master rules for this codebase. Read this first — the non-negotiables, layout, and conventions.

## What Iris is

Iris gives AI coding agents **eyes** into a running web app — without screenshots. The app embeds a dev-only SDK that instruments the DOM, network, routing, console, animations, and framework state; a local bridge + MCP server exposes that as structured tools the agent uses to **look, act, observe, and assert**. See `plan/` for the full design (gitignored).

## Monorepo layout

```
packages/protocol      @syrin/iris-protocol     — shared wire contract, constants, zod schemas
packages/browser       @syrin/iris-browser      — instrumentation SDK embedded in the app (DOM-side)
packages/server        @syrin/iris-server       — bridge + MCP server, the `iris` CLI (Node-side)
packages/react         @syrin/iris-react        — React adapter: DOM ref -> component -> source file
packages/babel-plugin  @syrin/iris-babel-plugin — stamps data-iris-source (source mapping, React 19)
packages/next          @syrin/iris-next         — Next.js source mapping (keeps SWC) via withIris (CJS)
apps/demo              @syrin/iris-demo         — Vite/React dashboard used to dogfood Iris
apps/api               @syrin/iris-api          — Express backend exercising real-world behaviors (CJS-ish .mjs)
apps/next-smoke        @syrin/iris-next-smoke   — Next.js 15 app verifying Iris on Next
docs/                  — user-facing docs (getting-started, usage, token-efficiency, local-install)
skill/                 — PUBLIC skill for users integrating Iris into their own project
plan/                  — research/design docs + throwaway test harnesses (ALWAYS gitignored)
```

This is **one git repo** at the root (pnpm + turbo monorepo). The TS library packages are strict TypeScript; `@syrin/iris-babel-plugin`/`@syrin/iris-next` are plain CJS tooling and `apps/api`/ `apps/next-smoke` are local fixtures — all excluded from the build/lint/test gates.

## Service boundaries (who owns what)

- **`@syrin/iris-protocol` is the contract.** Any message that crosses browser ↔ bridge ↔ agent is defined there as a constant + zod schema. Browser and server depend on it; it depends on nothing. Never inline a wire string in `browser` or `server` — add it to `protocol`.
- **`@syrin/iris-browser` only touches the DOM/page.** It never imports Node APIs.
- **`@syrin/iris-server` only runs in Node.** It never imports DOM APIs.
- **`@syrin/iris-react` is optional enrichment.** Core must work without it.

## Non-negotiable rules

1. **Equality:** `===`/`!==` always. `eqeqeq` is an error.
2. **No `any`.** Use `unknown` + zod narrowing at boundaries. `no-explicit-any` is an error.
3. **No free strings.** Every domain/wire/UI string is a named constant.
4. **No non-null `!`.** Use optional chaining + explicit null checks.
5. **Tests first.** RED → GREEN → REFACTOR.
6. **500-line file cap.** Over it = a cohesion failure; split before adding.
7. **Inject the clock.** Never call `Date.now()`/`Math.random()` inside pure logic — pass them in.
8. **Scope every data access to the authenticated principal.**
9. **Design tokens are the only place design values live.**
10. **No internal tracking tags.** Comments, file names, directory names, and test descriptions must never contain design-doc reference codes (letter + digit patterns like `N5`, `G4`, `M8`, `P2`, `F1`, `R1`) or internal version strings (like `0.3.7`).

## Naming conventions

| Thing | Convention | Example |
| --- | --- | --- |
| Package | `@syrin/<kebab>` | `@syrin/iris-browser` |
| File | kebab-case | `ring-buffer.ts` |
| Type / class | PascalCase | `RingBuffer`, `IrisEvent` |
| Variable / function | camelCase | `pushEvent` |
| Constant object | PascalCase + `as const` | `EventType`, `ActionType` |
| React component file | PascalCase or `create-` prefix for creation flows | `App.tsx`, `create-session-view.tsx` |
| `useX` function | ONLY if it calls React hooks | else use `apply/build/get/handle` |

## Pre/post-coding checklist

**Before coding:** scan for existing code to reuse → identify the constants you'll need and add them first → write the failing test. **After coding:** refactor with tests green → check file < 500 lines → run `pnpm lint && pnpm typecheck && pnpm test:unit` → confirm no `any`, no free strings, no `console.log`.
