# Test unpublished Reticle changes in a real app (local registry)

> **For normal use, Reticle is on public npm** — just `npm i -D @reticlehq/react @reticlehq/vite-plugin` (see [Getting Started](getting-started.md)). You only need this guide to test **local, unpublished changes** to the Reticle packages in a real external app before they ship.

Because the `@reticlehq/*` packages depend on each other via the workspace protocol, plain `npm pack` tarballs don't resolve cleanly. The reliable way to exercise your in-progress changes in a real app is a tiny **local registry** (Verdaccio) — the same path CI uses to validate a publish.

## 1. Publish @reticlehq/\* to a local registry

From the Reticle repo:

```bash
bash scripts/local-registry.sh
```

This starts a **fresh** Verdaccio on `http://localhost:4873`, creates a user/token, and publishes all `@reticlehq/*` packages there at the current workspace version:

| Package | What you install it for |
| --- | --- |
| **`@reticlehq/react`** | **install this** — the browser SDK kit you embed (re-exports the browser sensor, so one install gives both `reticle` and `install`) |
| `@reticlehq/vite-plugin` | dev-only source mapping + `connect()` injection (Vite) |
| `@reticlehq/next` | Next.js build wrapper (`withReticle`) |
| `@reticlehq/server` | the bridge + MCP server (your agent runs it, `npx @reticlehq/server mcp`) |
| `@reticlehq/babel-plugin` | React 19 source stamping (Babel) |
| `@reticlehq/test` | write declarative, signal-bound specs (`reticleTest`) |
| `@reticlehq/eslint-plugin` | the `require-signal-on-mutation` lint rule |
| `@reticlehq/core` | shared wire contract (pulled in automatically) |

For a browser app, install `@reticlehq/react` plus the build plugin for your framework (`@reticlehq/vite-plugin` or `@reticlehq/next`); `@reticlehq/server` is what your agent runs. (Verified: an external `npm i @reticlehq/react` resolves its graph, including `@reticlehq/core`, and imports correctly.) Leave the registry running.

> Note: pre-2.0 docs used a single `@reticlehq/core` umbrella package that re-exported everything; it's been split into the audience-scoped packages above.

## 2. Point your app at the local registry

In your app's project root, add an `.npmrc` (scopes only `@reticle` to the local registry; everything else still comes from npm):

```ini
@reticle:registry=http://localhost:4873/
```

## 3. Install + wire it up

Install the SDK kit plus the Vite build plugin (source mapping + `connect()` injection):

```bash
npm i -D @reticlehq/react @reticlehq/vite-plugin
# Next.js instead of Vite? npm i -D @reticlehq/react @reticlehq/next
# optional: npm i -D @reticlehq/eslint-plugin   # require-signal-on-mutation lint rule
```

Then follow [Getting Started](getting-started.md): embed `reticle.connect()` (dev only) from `@reticlehq/react`, add the MCP server to your agent, and (React) `install()` the adapter from `@reticlehq/react`. For the fastest agent loop, also do [Step 6 — make your app agent-legible](getting-started.md) (testids, `reticle.signal`, `registerStore`, `registerCapabilities`) and the [integration patterns](integration-patterns.md) (`createReticleEmitter` for zero prod-bundle cost).

> **Upgrading.** The packages are currently **1.2.0**; new tools land as minor bumps. `scripts/local-registry.sh` resets Verdaccio and republishes the current version, so pull the latest in your app explicitly — `npm install @reticlehq/react@latest`:
>
> ```bash
> npm i -D @reticlehq/react@latest @reticlehq/vite-plugin@latest @reticlehq/eslint-plugin@latest
> ```

**Run the MCP server** from the local registry too — `npx @reticlehq/server` _is_ the server:

```jsonc
// .mcp.json — point npx at the local registry so it fetches @reticlehq/server from Verdaccio
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["--registry", "http://localhost:4873/", "@reticlehq/server", "mcp"],
    },
  },
}
```

## Next.js specifics (verified on Next 15 / React 19)

`next.config.mjs`:

```js
import reticleNext from '@reticlehq/next';
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default reticleNext.withReticle(nextConfig); // dev-only; keeps SWC; adds file:line mapping
```

Mount the SDK from a dev-only client component (see the Next.js section in [Getting Started](getting-started.md)).

## Real input for hover/drag (optional)

Synthetic events can't trigger native `onMouseEnter`/pointer state (hover menus, tooltips, pointer drag). Enable **real input** so the server drives genuine pointer input and `reticle_act` reports `inputMode:"real"`:

- **Easiest — `reticle drive`:** Reticle launches its own scriptable, headless-capable browser at your app URL (no flags to juggle):

  ```bash
  npx --registry http://localhost:4873/ @reticlehq/server drive http://localhost:4310   # add --headed to watch
  ```

- **Or attach to your own browser:** launch it with `--remote-debugging-port=9222`, then point the MCP server at it via `env`:

  ```jsonc
  // .mcp.json
  {
    "mcpServers": {
      "reticle": {
        "command": "npx",
        "args": ["--registry", "http://localhost:4873/", "@reticlehq/server", "mcp"],
        "env": { "RETICLE_CDP_URL": "http://localhost:9222" },
      },
    },
  }
  ```

With neither set, Reticle stays synthetic (zero extra deps) and says so via `inputMode`. See [usage §18](usage.md#18-real-input-mode--native-hover--drag-m58).

## Write replayable specs + git-checked flows

- **Specs:** with `@reticlehq/test`, turn checks into `reticleTest("…", async t => { await t.act(...); await t.expectSignal(...) })` — signal/testid-bound, `reticle_clock` for determinism, `t.expectInputModeReal()` to skip-with-reason when real input isn't active. Run them headless via `reticle drive` (the same path CI uses).
- **Flows:** record a flow once and Reticle writes it to a git-checked `.reticle/flows/<name>.json` (anchored on testid/signal); `reticle_flow_replay` re-resolves anchors at run time and reports **legible drift** with a nearest-match; `reticle_flow_heal` proposes/applies the rebind. A fresh agent reads `.reticle/contract.json` to learn your testable surface without grepping source.

## When you're ready for real npm

The same packages publish to public npm unchanged — `pnpm -r publish --access public` after `npm login`. The Verdaccio run above is a faithful rehearsal of that.

## Cleanup

```bash
pkill -f verdaccio     # stop the local registry
# remove the line from your app's .npmrc when you switch to published packages
```
