# Migrating to Reticle v2

v2 retires the `@reticlehq/core` **umbrella**. In v1, `@reticlehq/core` was a single published package that re-exported everything under subpaths (`@reticlehq/core/next`, `/test`, `/server`, …), so installing it dragged the Node MCP server, `ws`, and DOM libraries into every app regardless of what you actually used.

v2 splits that into **audience-scoped packages** and inverts `@reticlehq/core` into the **bottom-of-graph foundation**: the small, isomorphic wire contract (types, zod schemas, constants, messages) that every other package depends on. `core` now depends only on `zod` and re-exports nothing.

Nothing about the runtime protocol changed — only which package you install and import from.

## Install: one umbrella → one door per audience

| You are… | v1 | v2 |
| --- | --- | --- |
| A browser app (React / Vite / Next) | `npm i @reticlehq/core` | `npx @reticlehq/server init` (installs `@reticlehq/react` + the build plugin), or manually `npm i -D @reticlehq/react @reticlehq/vite-plugin` (Vite) / `@reticlehq/next` (Next) |
| An agent running the MCP server | `npx @reticlehq/core mcp` | `npx @reticlehq/server mcp` |
| Writing CI specs | `@reticlehq/core/test` | `@reticlehq/test` |

## Imports

| v1 | v2 |
| --- | --- |
| `import { reticle, install } from '@reticlehq/core'` | `import { reticle, install } from '@reticlehq/react'` |
| `import { reticle } from '@reticlehq/core/vite'` | `import { reticle } from '@reticlehq/vite-plugin'` |
| `import { withReticle } from '@reticlehq/core/next'` | `import { withReticle } from '@reticlehq/next'` |
| `import ... from '@reticlehq/core/babel'` | `import ... from '@reticlehq/babel-plugin'` |
| `import { reticleTest } from '@reticlehq/core/test'` | `import { reticleTest } from '@reticlehq/test'` |
| `import { start } from '@reticlehq/core/server'` | `import { start } from '@reticlehq/server'` |

The `@reticlehq/react` kit re-exports the browser sensor, so a single install gives you both the `reticle` instance and the React `install()` adapter.

## `@reticlehq/protocol` → `@reticlehq/core`

The wire contract that used to live in `@reticlehq/protocol` now lives in `@reticlehq/core`. `@reticlehq/protocol` remains as a **thin deprecated alias** that re-exports `@reticlehq/core` for one major version, and will be **removed in v3**.

```diff
- import { EventType, wireMessageSchema } from '@reticlehq/protocol';
+ import { EventType, wireMessageSchema } from '@reticlehq/core';
```

## The four rules `@reticlehq/core` now satisfies

1. **Bottom-of-graph** — its only dependency is `zod`.
2. **Isomorphic** — no DOM-only or Node-only code; it runs anywhere.
3. **Rarely-changing** — it is the stable contract, not a feature surface.
4. **Re-exports nothing** — audience packages import _from_ it; it imports from none of them.

A CI dependency-boundary guard (`scripts/check-boundaries.mjs`) enforces this mechanically so the umbrella cannot come back.
