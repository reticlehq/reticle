# Use Reticle in your own app — without publishing to npm

Reticle isn't on public npm yet, and its packages depend on each other (`@reticlehq/browser` → `@reticlehq/protocol`, etc.), so plain `npm pack` tarballs don't resolve cleanly. The reliable way to test it in your **real external app today** is a tiny **local registry** (Verdaccio). This is also exactly the path we use to validate publishing.

## 1. Publish @reticlehq/\* to a local registry

From the Reticle repo:

```bash
bash scripts/local-registry.sh
```

This starts a **fresh** Verdaccio on `http://localhost:4873`, creates a user/token, and publishes all `@reticlehq/*` packages there at the current version (**1.2.0**):

| Package | What you install it for |
| --- | --- |
| **`@reticlehq/core`** | **the one install** — re-exports everything below |
| `@reticlehq/browser` | the dev-only SDK you embed in your app |
| `@reticlehq/server` | the bridge + MCP server (your agent runs it) |
| `@reticlehq/react` | DOM → component → source-file mapping |
| `@reticlehq/babel-plugin` / `@reticlehq/next` | React 19 source mapping (Vite / Next.js) |
| `@reticlehq/test` | write declarative, signal-bound specs (`reticleTest`) |
| `@reticlehq/eslint-plugin` | the `require-signal-on-mutation` lint rule |
| `@reticlehq/protocol` | shared wire contract (pulled in automatically) |

Most users only need **`@reticlehq/core`** (it re-exports the SDK + React adapter at `.`, and the plugins/runner/server at `@reticlehq/core/{next,babel,test,server}`); the rest stay available for granular installs. (Verified: an external `npm i @reticlehq/core` resolves the whole graph, including `@reticlehq/protocol`, and imports correctly.) Leave it running.

## 2. Point your app at the local registry

In your app's project root, add an `.npmrc` (scopes only `@reticle` to the local registry; everything else still comes from npm):

```ini
@reticle:registry=http://localhost:4873/
```

## 3. Install + wire it up

**One install** brings the SDK, React adapter, source-mapping plugins, the spec runner, and the MCP server:

```bash
npm i -D @reticlehq/core
# optional: npm i -D @reticlehq/eslint-plugin   # require-signal-on-mutation lint rule
```

Then follow [Getting Started](getting-started.md): embed `reticle.connect()` (dev only) from `@reticlehq/core`, add the MCP server to your agent, and (React) `install()` the adapter from `@reticlehq/core`. For the fastest agent loop, also do [Step 6 — make your app agent-legible](getting-started.md) (testids, `reticle.signal`, `registerStore`, `registerCapabilities`) and the [integration patterns](integration-patterns.md) (`createReticleEmitter` for zero prod-bundle cost).

> **Upgrading.** The package is currently **1.2.0**; new tools land as minor bumps. `scripts/local-registry.sh` resets Verdaccio and republishes the current version, so pull the latest in your app explicitly — `npm install @reticlehq/core@latest`:
>
> ```bash
> npm i -D @reticlehq/core@latest @reticlehq/eslint-plugin@latest
> ```

**Run the MCP server** from the local registry too — `npx @reticlehq/core` _is_ the server:

```jsonc
// .mcp.json — point npx at the local registry so it fetches @reticlehq/core from Verdaccio
{
  "mcpServers": {
    "reticle": {
      "command": "npx",
      "args": ["--registry", "http://localhost:4873/", "@reticlehq/core"],
    },
  },
}
```

## Next.js specifics (verified on Next 15 / React 19)

`next.config.mjs`:

```js
import reticleNext from '@reticlehq/core/next';
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default reticleNext.withReticle(nextConfig); // dev-only; keeps SWC; adds file:line mapping
```

Mount the SDK from a dev-only client component (see the Next.js section in [Getting Started](getting-started.md)).

## Real input for hover/drag (optional)

Synthetic events can't trigger native `onMouseEnter`/pointer state (hover menus, tooltips, pointer drag). Enable **real input** so the server drives genuine pointer input and `reticle_act` reports `inputMode:"real"`:

- **Easiest — `reticle drive`:** Reticle launches its own scriptable, headless-capable browser at your app URL (no flags to juggle):

  ```bash
  npx --registry http://localhost:4873/ @reticlehq/core drive http://localhost:4310   # add --headed to watch
  ```

- **Or attach to your own browser:** launch it with `--remote-debugging-port=9222`, then point the MCP server at it via `env`:

  ```jsonc
  // .mcp.json
  {
    "mcpServers": {
      "reticle": {
        "command": "npx",
        "args": ["--registry", "http://localhost:4873/", "@reticlehq/core"],
        "env": { "RETICLE_CDP_URL": "http://localhost:9222" },
      },
    },
  }
  ```

With neither set, Reticle stays synthetic (zero extra deps) and says so via `inputMode`. See [usage §18](usage.md#18-real-input-mode--native-hover--drag-m58).

## Write replayable specs + git-checked flows

- **Specs:** with `@reticlehq/core/test`, turn checks into `reticleTest("…", async t => { await t.act(...); await t.expectSignal(...) })` — signal/testid-bound, `reticle_clock` for determinism, `t.expectInputModeReal()` to skip-with-reason when real input isn't active. Run them headless via `reticle drive` (the same path CI uses).
- **Flows:** record a flow once and Reticle writes it to a git-checked `.reticle/flows/<name>.json` (anchored on testid/signal); `reticle_flow_replay` re-resolves anchors at run time and reports **legible drift** with a nearest-match; `reticle_flow_heal` proposes/applies the rebind. A fresh agent reads `.reticle/contract.json` to learn your testable surface without grepping source.

## When you're ready for real npm

The same packages publish to public npm unchanged — `pnpm -r publish --access public` after `npm login`. The Verdaccio run above is a faithful rehearsal of that.

## Cleanup

```bash
pkill -f verdaccio     # stop the local registry
# remove the line from your app's .npmrc when you switch to published packages
```
