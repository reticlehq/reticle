# Contributing to Iris

Thanks for your interest in Iris! Iris gives AI coding agents **eyes** into a running web app —
without screenshots. It instruments the DOM, network, routing, console, and framework state in your
app, and exposes that to an agent over MCP as a `look → act → observe → assert` loop.

This guide covers how to set up the repo, the rules we hold the line on, and how to land a change.
We aim to make contributing pleasant — if anything here is unclear, open an issue.

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

---

## Prerequisites

- **Node.js `>=22.12`** (see `engines` in the root `package.json`).
- **pnpm `10.x`** — the repo pins `pnpm@10.33.2` via `packageManager`. The easiest way to get the
  right version is [Corepack](https://nodejs.org/api/corepack.html):

  ```bash
  corepack enable
  ```

This is a single git repo — a **pnpm + [turbo](https://turbo.build/) monorepo**. Install everything
from the root:

```bash
pnpm install
```

---

## Repository layout

```
packages/protocol      @syrin/iris-protocol     — shared wire contract, constants, zod schemas
packages/browser       @syrin/iris-browser      — instrumentation SDK embedded in the app (DOM-side)
packages/server        @syrin/iris-server       — bridge + MCP server, the `iris` CLI (Node-side)
packages/react         @syrin/iris-react        — React adapter: DOM ref -> component -> source file
packages/babel-plugin  @syrin/iris-babel-plugin — stamps data-iris-source (source mapping, React 19)
packages/next          @syrin/iris-next         — Next.js source mapping (keeps SWC) via withIris (CJS)
apps/demo              @syrin/iris-demo         — Vite/React dashboard used to dogfood Iris
apps/api              @syrin/iris-api          — Express backend exercising real-world behaviors
apps/next-smoke       @syrin/iris-next-smoke   — Next.js 15 app verifying Iris on Next
docs/                  — user-facing docs (getting-started, usage, token-efficiency, local-install)
skill/                — public skill for users integrating Iris into their own project
```

The TypeScript library packages (`-protocol`, `-browser`, `-server`, `-react`) are **strict
TypeScript** and are the focus of the build/lint/test gates. `@syrin/iris-babel-plugin` /
`@syrin/iris-next` are plain CJS tooling, and `apps/api` / `apps/next-smoke` are local fixtures —
these are excluded from the gates.

### Service boundaries (who owns what)

- **`@syrin/iris-protocol` is the contract.** Any message that crosses browser ↔ bridge ↔ agent is
  defined there as a constant + zod schema. Browser and server depend on it; it depends on nothing.
  Never inline a wire string in `browser` or `server` — add it to `protocol`.
- **`@syrin/iris-browser` only touches the DOM/page.** It never imports Node APIs.
- **`@syrin/iris-server` only runs in Node.** It never imports DOM APIs.
- **`@syrin/iris-react` is optional enrichment.** Core must work without it.

---

## Build, lint, typecheck, test

All gates run from the repo root and fan out across packages via turbo:

```bash
pnpm build       # turbo run build
pnpm lint        # turbo run lint
pnpm typecheck   # turbo run typecheck
pnpm test:unit   # turbo run test:unit   (pnpm test is an alias)
```

Before you push, the full local gate is:

```bash
pnpm lint && pnpm typecheck && pnpm test:unit
```

Other useful scripts: `pnpm format` / `pnpm format:check` (Prettier), and `pnpm bench` (the
benchmark harness — see [`bench/SCORECARD.md`](bench/SCORECARD.md)).

---

## Test-driven development

We write tests first: **RED → GREEN → REFACTOR.**

1. **RED** — write a failing test that pins the behavior you want.
2. **GREEN** — write the minimum code to make it pass.
3. **REFACTOR** — clean up with the test green; check the file is still under the 500-line cap.

Every behavior change ships with a test. Bug fixes start with a test that reproduces the bug.

---

## Coding rules (non-negotiable)

These are enforced by lint and review. A PR that violates them will be asked to change.

1. **Equality:** `===` / `!==` always. `eqeqeq` is an error.
2. **No `any`.** Use `unknown` + zod narrowing at boundaries. `no-explicit-any` is an error.
3. **No free strings.** Every domain / wire / UI string is a named constant. Wire strings live in
   `@syrin/iris-protocol`, never inlined in `browser` or `server`.
4. **No non-null `!`.** Use optional chaining + explicit null checks.
5. **Tests first** (see above).
6. **500-line file cap.** Over it = a cohesion failure; split before adding.
7. **Inject the clock.** Never call `Date.now()` / `Math.random()` inside pure logic — pass them in.
8. **Scope every data access to the authenticated principal.**
9. **Design tokens are the only place design values live.**
10. **No internal tracking tags.** Comments, file names, directory names, and test descriptions must
    never contain design-doc reference codes or internal version strings.
11. **No `console.log`** left in committed code.

### Naming conventions

| Thing                | Convention                                        | Example                              |
| -------------------- | ------------------------------------------------- | ------------------------------------ |
| Package              | `@syrin/<kebab>`                                  | `@syrin/iris-browser`                |
| File                 | kebab-case                                        | `ring-buffer.ts`                     |
| Type / class         | PascalCase                                        | `RingBuffer`, `IrisEvent`            |
| Variable / function  | camelCase                                         | `pushEvent`                          |
| Constant object      | PascalCase + `as const`                           | `EventType`, `ActionType`            |
| React component file | PascalCase or `create-` prefix for creation flows | `App.tsx`, `create-session-view.tsx` |
| `useX` function      | ONLY if it calls React hooks                      | else use `apply/build/get/handle`    |

---

## Running the demo app locally

`apps/demo` is the React dashboard we use to dogfood Iris (tabs, lists, modals, forms, API calls).

```bash
pnpm install                 # once, from the repo root
pnpm --filter @syrin/iris-demo dev
```

This starts the Vite dev server. There is also a dedicated, isolated Iris dev server on port 4310
(so it doesn't collide with your normal dev port):

```bash
pnpm --filter @syrin/iris-demo dev:iris   # http://localhost:4310
```

From there, point your MCP-capable agent at Iris and ask it to verify the app — see
[`docs/getting-started.md`](docs/getting-started.md) for the full walkthrough.

---

## Commit and pull-request flow

1. **Branch off `main`.** Use a short, descriptive branch name.
2. **Write tests first** for the behavior you're adding or fixing.
3. **Use [Conventional Commits](https://www.conventionalcommits.org/)** for commit messages, e.g.
   `feat(server): add iris_viewport tool`, `fix(browser): restore patched fetch on teardown`,
   `docs: clarify install steps`. Common scopes mirror the packages: `protocol`, `browser`,
   `server`, `react`, plus `docs` / `chore`.
4. **Keep the gates green:** `pnpm lint && pnpm typecheck && pnpm test:unit`.
5. **Update docs and `CHANGELOG.md`** when the change is user-facing. New entries go under the
   `[Unreleased]` section, following [Keep a Changelog](https://keepachangelog.com/).
6. **Open a PR against `main`** and **link the issue** it resolves (e.g. `Closes #123`). Fill out the
   PR template checklist.

For anything non-trivial, **open an issue first** so we can agree on the approach before you invest
time in a PR.

---

## License of contributions

Iris uses a per-package license model (Apache-2.0 for the embeddable SDK packages, FSL-1.1-ALv2 for
the server / CLI / umbrella, and the Iris Enterprise License for `packages/server/src/ee/`). By
contributing, you agree that your contribution is licensed under the license of the package(s) you're
modifying. See the root [LICENSE](LICENSE) and each package's own `LICENSE` file.
