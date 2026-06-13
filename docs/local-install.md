# Use Iris in your own app — without publishing to npm

Iris isn't on public npm yet, and its packages depend on each other (`@syrin/iris-browser` →
`@syrin/iris-protocol`, etc.), so plain `npm pack` tarballs don't resolve cleanly. The reliable way
to test it in your **real external app today** is a tiny **local registry** (Verdaccio). This
is also exactly the path we use to validate publishing.

## 1. Publish @syrin/\* to a local registry

From the Iris repo:

```bash
bash scripts/local-registry.sh
```

This starts a **fresh** Verdaccio on `http://localhost:4873`, creates a user/token, and
publishes all `@syrin/*` packages there at the current version (**0.3.0**):

| Package                                         | What you install it for                            |
| ----------------------------------------------- | -------------------------------------------------- |
| **`@syrin/iris`**                               | **the one install** — re-exports everything below  |
| `@syrin/iris-browser`                           | the dev-only SDK you embed in your app             |
| `@syrin/iris-server`                            | the bridge + MCP server (your agent runs it)       |
| `@syrin/iris-react`                             | DOM → component → source-file mapping              |
| `@syrin/iris-babel-plugin` / `@syrin/iris-next` | React 19 source mapping (Vite / Next.js)           |
| `@syrin/iris-test`                              | write declarative, signal-bound specs (`irisTest`) |
| `@syrin/iris-eslint-plugin`                     | the `require-signal-on-mutation` lint rule         |
| `@syrin/iris-protocol`                          | shared wire contract (pulled in automatically)     |

Most users only need **`@syrin/iris`** (it re-exports the SDK + React adapter at `.`, and the
plugins/runner/server at `@syrin/iris/{next,babel,test,server}`); the rest stay available for
granular installs. (Verified: an external `npm i @syrin/iris` resolves the whole graph, including
`@syrin/iris-protocol`, and imports correctly.) Leave it running.

## 2. Point your app at the local registry

In your app's project root, add an `.npmrc` (scopes only `@iris` to the local registry;
everything else still comes from npm):

```ini
@syrin:registry=http://localhost:4873/
```

## 3. Install + wire it up

**One install** brings the SDK, React adapter, source-mapping plugins, the spec runner, and the
MCP server:

```bash
npm i -D @syrin/iris
# optional: npm i -D @syrin/iris-eslint-plugin   # require-signal-on-mutation lint rule
```

Then follow [Getting Started](getting-started.md): embed `iris.connect()` (dev only) from
`@syrin/iris`, add the MCP server to your agent, and (React) `install()` the adapter from
`@syrin/iris`. For the fastest agent loop, also do
[Step 6 — make your app agent-legible](getting-started.md) (testids, `iris.signal`,
`registerStore`, `registerCapabilities`) and the
[integration patterns](integration-patterns.md) (`createIrisEmitter` for zero prod-bundle cost).

> **Upgrading.** The package is pre-1.0 (currently **0.3.0**), so new tools land as minor bumps.
> `scripts/local-registry.sh` resets Verdaccio and republishes the current version, so pull the
> latest in your app explicitly — `npm update` won't cross a `0.x` minor:
>
> ```bash
> npm i -D @syrin/iris@latest @syrin/iris-eslint-plugin@latest
> ```

**Run the MCP server** from the local registry too — `npx @syrin/iris` _is_ the server:

```jsonc
// .mcp.json — point npx at the local registry so it fetches @syrin/iris from Verdaccio
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["--registry", "http://localhost:4873/", "@syrin/iris"],
    },
  },
}
```

## Next.js specifics (verified on Next 15 / React 19)

`next.config.mjs`:

```js
import irisNext from '@syrin/iris/next';
/** @type {import('next').NextConfig} */
const nextConfig = {};
export default irisNext.withIris(nextConfig); // dev-only; keeps SWC; adds file:line mapping
```

Mount the SDK from a dev-only client component (see the Next.js section in
[Getting Started](getting-started.md)).

## Real input for hover/drag (optional, 0.3.0+)

Synthetic events can't trigger native `onMouseEnter`/pointer state (hover menus, tooltips,
pointer drag). Enable **real input** so the server drives genuine pointer input and `iris_act`
reports `inputMode:"real"`:

- **Easiest — `iris drive`:** Iris launches its own scriptable, headless-capable browser at
  your app URL (no flags to juggle):

  ```bash
  npx --registry http://localhost:4873/ @syrin/iris drive http://localhost:3000   # add --headed to watch
  ```

- **Or attach to your own browser:** launch it with `--remote-debugging-port=9222`, then point
  the MCP server at it via `env`:

  ```jsonc
  // .mcp.json
  {
    "mcpServers": {
      "iris": {
        "command": "npx",
        "args": ["--registry", "http://localhost:4873/", "@syrin/iris"],
        "env": { "IRIS_CDP_URL": "http://localhost:9222" },
      },
    },
  }
  ```

With neither set, Iris stays synthetic (zero extra deps) and says so via `inputMode`. See
[usage §18](usage.md#18-real-input-mode--native-hover--drag-m58).

## Write replayable specs + git-checked flows (0.3.0+)

- **Specs:** with `@syrin/iris/test`, turn checks into `irisTest("…", async t => { await t.act(...);
await t.expectSignal(...) })` — signal/testid-bound, `iris_clock` for determinism,
  `t.expectInputModeReal()` to skip-with-reason when real input isn't active. Run them headless
  via `iris drive` (the same path CI uses).
- **Flows:** record a flow once and Iris writes it to a git-checked `.iris/flows/<name>.json`
  (anchored on testid/signal); `iris_flow_replay` re-resolves anchors at run time and reports
  **legible drift** with a nearest-match; `iris_flow_heal` proposes/applies the rebind. A fresh
  agent reads `.iris/contract.json` to learn your testable surface without grepping source.

## When you're ready for real npm

The same packages publish to public npm unchanged — `pnpm -r publish --access public` after
`npm login`. The Verdaccio run above is a faithful rehearsal of that.

## Cleanup

```bash
pkill -f verdaccio     # stop the local registry
# remove the line from your app's .npmrc when you switch to published packages
```
