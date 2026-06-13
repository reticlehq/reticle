# CLAUDE.md — Iris

> Master rules for this codebase. Read this first. The `skills/` files hold the depth;
> this file holds the non-negotiables and points you to the right skill.

## What Iris is

Iris gives AI coding agents **eyes** into a running web app — without screenshots. The app
embeds a dev-only SDK that instruments the DOM, network, routing, console, animations, and
framework state; a local bridge + MCP server exposes that as structured tools the agent
uses to **look, act, observe, and assert**. See `plan/` for the full design (gitignored).

## Monorepo layout

```
packages/protocol   @iris/protocol  — shared wire contract, constants, zod schemas
packages/browser    @iris/browser   — instrumentation SDK embedded in the app (DOM-side)
packages/server     @iris/server    — bridge + MCP server, the `iris` CLI (Node-side)
packages/react      @iris/react     — React adapter: DOM ref -> component stack -> source file
apps/demo           @iris/demo      — React dashboard used to dogfood Iris
skills/             — engineering reference docs (open the one that matches your task)
plan/               — research/design docs (ALWAYS gitignored, never ship)
```

This is **one git repo** at the root (pnpm + turbo monorepo). Pure TypeScript; no Python.

## Service boundaries (who owns what)

- **`@iris/protocol` is the contract.** Any message that crosses browser ↔ bridge ↔ agent
  is defined there as a constant + zod schema. Browser and server depend on it; it depends
  on nothing. Never inline a wire string in `browser` or `server` — add it to `protocol`.
- **`@iris/browser` only touches the DOM/page.** It never imports Node APIs.
- **`@iris/server` only runs in Node.** It never imports DOM APIs.
- **`@iris/react` is optional enrichment.** Core must work without it.

## Non-negotiable rules (the short list — depth in skills/)

1. **Equality:** `===`/`!==` always. `eqeqeq` is an error. → `skills/typescript.md`
2. **No `any`.** Use `unknown` + zod narrowing at boundaries. `no-explicit-any` is an error.
3. **No free strings.** Every domain/wire/UI string is a named constant. → `skills/conventions.md`
4. **No non-null `!`.** Use optional chaining + explicit null checks.
5. **Tests first.** RED → GREEN → REFACTOR. → `skills/testing.md`
6. **500-line file cap.** Over it = a cohesion failure; split before adding. → `skills/conventions.md`
7. **Inject the clock.** Never call `Date.now()`/`Math.random()` inside pure logic — pass them in.
8. **Scope every data access to the authenticated principal.** → `skills/security.md`
9. **Design tokens are the only place design values live.** → `skills/design.md`

## Naming conventions

| Thing                | Convention                                        | Example                              |
| -------------------- | ------------------------------------------------- | ------------------------------------ |
| Package              | `@iris/<kebab>`                                   | `@iris/browser`                      |
| File                 | kebab-case                                        | `ring-buffer.ts`                     |
| Type / class         | PascalCase                                        | `RingBuffer`, `IrisEvent`            |
| Variable / function  | camelCase                                         | `pushEvent`                          |
| Constant object      | PascalCase + `as const`                           | `EventType`, `ActionType`            |
| React component file | PascalCase or `create-` prefix for creation flows | `App.tsx`, `create-session-view.tsx` |
| `useX` function      | ONLY if it calls React hooks                      | else use `apply/build/get/handle`    |

## Skills index — open the file that matches the task

| Task                                            | Open                      |
| ----------------------------------------------- | ------------------------- |
| Building any UI / dev overlay                   | `skills/design.md`        |
| TypeScript pattern or rule                      | `skills/typescript.md`    |
| Python (N/A here, kept for parity)              | `skills/python.md`        |
| Before writing any feature                      | `skills/testing.md`       |
| Naming / constants                              | `skills/conventions.md`   |
| Multi-agent / MCP tool design                   | `skills/agents.md`        |
| New package or wire contract                    | `skills/architecture.md`  |
| Any persistence (baselines/recordings)          | `skills/database.md`      |
| Anything touching the bridge/transport security | `skills/security.md`      |
| Anything slow or memory-hungry                  | `skills/performance.md`   |
| Logs / metrics / debugging the bridge           | `skills/observability.md` |
| Any new MCP tool surface                        | `skills/api-design.md`    |
| CI / build / release                            | `skills/cicd.md`          |

## Pre/post-coding checklist

**Before coding:** scan for existing code to reuse → identify the constants you'll need and
add them first → write the failing test.
**After coding:** refactor with tests green → check file < 500 lines → run
`pnpm lint && pnpm typecheck && pnpm test:unit` → confirm no `any`, no free strings, no `console.log`.
